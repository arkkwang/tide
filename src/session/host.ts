import pty from "node-pty";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, unlinkSync } from "node:fs";
import { Screen, encodeText } from "../terminal/screen.js";
import { encodeKey } from "../terminal/keys.js";
import { Registry, validateId } from "./registry.js";
import { Display } from "./display.js";
import { listen } from "./ipc.js";
import { loadPlugins, Plugins } from "../plugins/runtime.js";
import { shellCommand, promptEnv, commandRegionEnv } from "../terminal/shell.js";
import { waitIdle } from "../terminal/idle.js";
import { requestResize, validateSize } from "../terminal/resize.js";
import type { Request, SessionInfo, SessionRecord, ShellOptions } from "./types.js";

export async function runSession(options: ShellOptions, id: string = randomUUID()): Promise<number> {
  validateId(id);
  const registry = new Registry();
  const configuredPlugins = await loadPlugins(registry.state);
  const { shell, args, cwd } = shellCommand(options);
  const cols = 100, rows = 30;
  let dimensions = { cols, rows };
  const screen = new Screen(cols, rows);
  const child = pty.spawn(shell, args, { name: "xterm-256color", cols, rows, cwd,
    env: { ...process.env, TERM: process.env.TERM && process.env.TERM !== "dumb" ? process.env.TERM : "xterm-256color", TIDE_SESSION_ID: id, TIDE_STATE_DIR: registry.state, TIDE_ENTRY: process.argv[1]!, ...commandRegionEnv(shell, promptEnv(shell, id)) },
  });
  const socketDirectory = join(tmpdir(), `tide-${process.getuid?.() ?? "local"}`);
  if (process.platform !== "win32") mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\tide-${id}` : join(socketDirectory, `${id}.sock`);
  const info: SessionInfo = { id, pid: process.pid, shellPid: child.pid, shell, cwd, createdAt: new Date().toISOString(), exited: false, exitCode: null };
  const record: SessionRecord = { ...info, endpoint, token: randomBytes(32).toString("hex") };
  let finish!: (code: number) => void;
  const ended = new Promise<number>((resolve) => { finish = resolve; });
  let stopping = false, registered = false, killRequested = false;
  let closeServer: (() => void) | undefined;
  let inputQueue = Promise.resolve();
  const enqueue = (operation: () => Promise<void>) => {
    const result = inputQueue.then(async () => { if (stopping || info.exited) throw Error("Shell has ended"); await operation(); });
    inputQueue = result.catch(() => {});
    return result;
  };
  const send = (text: string) => enqueue(async () => child.write(encodeText(text, (await screen.modes()).bracketedPasteMode)));
  const sendKey = (...keys: string[]) => enqueue(async () => {
    if (!keys.length || keys.length > 64 || !keys.every((key) => typeof key === "string")) throw Error("send --key requires 1..64 named keys/chords");
    const mode = (await screen.modes()).applicationCursorKeysMode;
    // Validate the whole sequence before writing any of it.
    const encoded = keys.map((key) => encodeKey(key, mode));
    child.write(encoded.join(""));
  });
  const plugins = new Plugins(configuredPlugins, { session: info, capture: (lines) => screen.capture(id, lines), send, sendKey });
  const killChild = () => {
    if (killRequested) return;
    killRequested = true;
    // Always ask node-pty to tear the pty down, even when the shell exited on its own:
    // that is what disposes its conout worker thread, and a live worker keeps this
    // process from ever ending.
    // FRAGILE: node-pty 1.1.0 disposes that worker from kill() and nowhere else, and
    // this host has no forced-exit fallback, so a version that stops doing so leaves
    // the host hanging silently. Only the integration test's exit budget reports it.
    child.kill();
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    killChild();
    finish(info.exitCode ?? 0);
  };
  let rendering = Promise.resolve();
  const sequence = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = rendering.then(operation);
    rendering = result.then(() => {}, () => {});
    return result;
  };
  const setSize = (cols: number, rows: number) => {
    if (stopping || info.exited) throw Error("Shell has ended");
    child.resize(cols, rows); screen.resize(cols, rows); dimensions = { cols, rows };
  };
  const display = new Display(record, {
    connect: (cols, rows, install) => sequence(async () => {
      setSize(cols, rows);
      install(await screen.serialize());
    }),
    input: data => enqueue(async () => child.write(data)),
    resize: (cols, rows) => sequence(async () => setSize(cols, rows)),
  });
  // With no viewer, xterm answers terminal queries (DA/DSR, etc.) so an
  // interactive program need not wait for attach to finish initializing.
  // An attached terminal answers for itself; never send duplicate responses.
  screen.onResponse(data => {
    if (display.state !== "attached") void enqueue(async () => child.write(data)).catch(() => {});
  });
  child.onData((data) => {
    void sequence(async () => {
      await screen.write(data);
      display.output(data);
      plugins.outputChanged();
    }).catch(error => { console.error(error); stop(); });
  });
  child.onExit(({ exitCode }) => { info.exited = true; info.exitCode = exitCode; finish(exitCode); });
  const emergencyCleanup = () => {
    if (registered) registry.remove(id);
    try { killChild(); } catch {}
  };
  try {
    await display.start();
    closeServer = await listen(record, async (request: Request, signal) => {
      switch (request.command) {
        case "info": return { ...info, display: display.state, ...await screen.activity() };
        case "attach-reserve": return { id, ...display.reserve() };
        case "attach-status": return { id, display: display.status(request.ticket) };
        case "attach-cancel": display.cancel(request.ticket); return { id };
        case "read": return sequence(() => screen.read(id, request.lines, request.full));
        case "wait-idle": return waitIdle(() => screen.capture(id), request.idleTime, request.timeout, signal);
        case "send": {
          if (("text" in request) === ("keys" in request)) throw Error("send requires exactly one of text or keys");
          if ("keys" in request) {
            if (!Array.isArray(request.keys)) throw Error("keys must be an array");
            await sendKey(...request.keys);
          } else await send(request.text);
          return { id, written: true };
        }
        case "scroll": await enqueue(async () => child.write(await screen.scroll(request.direction, request.steps, request.x, request.y))); return { id, written: true };
        case "resize": {
          let result: Awaited<ReturnType<typeof requestResize>> | undefined;
          await enqueue(async () => {
            validateSize(request.cols, request.rows);
            if (display.state !== "attached") {
              await sequence(async () => setSize(request.cols, request.rows));
              result = { requested: { cols: request.cols, rows: request.rows }, actual: dimensions, applied: true };
            } else {
              result = await requestResize(request.cols, request.rows, () => dimensions,
                () => display.requestResize(request.cols, request.rows), signal);
            }
          });
          return { id, ...result };
        }
        case "plugins": return plugins.list();
        case "plugin":
          if (!Array.isArray(request.args) || !request.args.every((arg) => typeof arg === "string")) throw Error("Plugin args must be strings");
          return plugins.run(request.plugin, request.action, request.args);
        case "close": setTimeout(stop, 100); return { id, closing: true };
        default: throw Error("Unknown command");
      }
    });
    registry.write(record); registered = true;
    process.on("exit", emergencyCleanup);
    process.on("SIGTERM", stop); process.on("SIGHUP", stop);
    console.error(`[tide] ${id}`);
    await plugins.start();
    return await ended;
  } finally {
    stopping = true;
    await rendering;
    display.dispose(info.exitCode ?? 0);
    await plugins.dispose(); closeServer?.();
    process.off("exit", emergencyCleanup); process.off("SIGTERM", stop); process.off("SIGHUP", stop);
    emergencyCleanup();
    if (process.platform !== "win32") { try { unlinkSync(endpoint); } catch {} }
    screen.dispose();
  }
}
