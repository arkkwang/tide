import pty from "node-pty";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, unlinkSync } from "node:fs";
import { Screen, encodeText } from "../terminal/screen.js";
import { encodeKey } from "../terminal/keys.js";
import { Registry, validateId } from "./registry.js";
import { listen } from "./ipc.js";
import { loadPlugins, Plugins } from "../plugins/runtime.js";
import { shellCommand } from "../terminal/shell.js";
import { waitIdle } from "../terminal/idle.js";
import { configureWindowsConsole } from "../terminal/windows-console.js";
import { writeTerminalOutput } from "../terminal/output.js";
import { requestResize } from "../terminal/resize.js";
import type { Request, SessionInfo, SessionRecord, ShellOptions } from "./types.js";

export async function runSession(options: ShellOptions, id: string = randomUUID()): Promise<number> {
  validateId(id);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error("tide run needs an interactive terminal; use tide launch to open one");
  const registry = new Registry();
  const configuredPlugins = await loadPlugins(registry.state);
  const { shell, args, cwd } = shellCommand(options);
  const cols = process.stdout.columns || 100, rows = process.stdout.rows || 30;
  const screen = new Screen(cols, rows);
  const child = pty.spawn(shell, args, { name: "xterm-256color", cols, rows, cwd,
    env: { ...process.env, TERM: process.env.TERM && process.env.TERM !== "dumb" ? process.env.TERM : "xterm-256color", TIDE_SESSION_ID: id, TIDE_STATE_DIR: registry.state, TIDE_ENTRY: process.argv[1]! },
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
    const result = inputQueue.then(async () => { if (stopping || info.exited) throw Error("Shell has exited"); await operation(); });
    inputQueue = result.catch(() => {});
    return result;
  };
  const send = (text: string) => enqueue(async () => child.write(encodeText(text, (await screen.modes()).bracketedPasteMode)));
  const sendKey = (...keys: string[]) => enqueue(async () => {
    if (!keys.length || !keys.every((key) => typeof key === "string")) throw Error("send-key needs one or more named keys");
    const mode = (await screen.modes()).applicationCursorKeysMode;
    // Validate the whole sequence before writing any of it.
    const encoded = keys.map((key) => encodeKey(key, mode));
    child.write(encoded.join(""));
  });
  const plugins = new Plugins(configuredPlugins, { session: info, capture: (lines) => screen.capture(id, lines), send, sendKey });
  const killChild = () => {
    if (killRequested || info.exited) return;
    killRequested = true;
    child.kill();
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    killChild();
    finish(info.exitCode ?? 0);
  };
  const input = (data: string) => { if (!stopping && !info.exited) child.write(data); };
  const resize = () => {
    if (stopping || info.exited) return;
    const cols = Math.max(1, process.stdout.columns || 100), rows = Math.max(1, process.stdout.rows || 30);
    child.resize(cols, rows); screen.resize(cols, rows);
  };
  child.onData((data) => {
    writeTerminalOutput(data);
    void screen.write(data).then(() => plugins.outputChanged());
  });
  child.onExit(({ exitCode }) => { info.exited = true; info.exitCode = exitCode; finish(exitCode); });
  const emergencyCleanup = () => {
    if (registered) registry.remove(id);
    try { killChild(); } catch {}
  };
  try {
    process.stdin.setEncoding("utf8"); process.stdin.setRawMode(true);
    configureWindowsConsole();
    closeServer = await listen(record, async (request: Request, signal) => {
      switch (request.command) {
        case "info": return { ...info, ...await screen.activity() };
        case "capture": return screen.capture(id, request.lines);
        case "wait-idle": return waitIdle(() => screen.capture(id), request.idleTime, request.timeout, signal);
        case "send": await send(request.text); return { id, written: true };
        case "scroll": await enqueue(async () => child.write(await screen.scroll(request.direction, request.steps, request.x, request.y))); return { id, written: true };
        case "resize": {
          let result: Awaited<ReturnType<typeof requestResize>> | undefined;
          await enqueue(async () => {
            result = await requestResize(request.cols, request.rows, () => ({ cols: process.stdout.columns, rows: process.stdout.rows }), writeTerminalOutput, signal);
            resize();
          });
          return { id, ...result };
        }
        case "send-key": if (!Array.isArray(request.keys)) throw Error("keys must be an array"); await sendKey(...request.keys); return { id, written: true };
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
    process.stdin.on("data", input); process.stdin.on("end", stop); process.stdin.resume();
    process.stdout.on("resize", resize);
    console.error(`[tide] ${id}`);
    await plugins.start();
    return await ended;
  } finally {
    stopping = true;
    process.stdin.pause();
    await plugins.dispose(); closeServer?.();
    process.off("exit", emergencyCleanup); process.off("SIGTERM", stop); process.off("SIGHUP", stop);
    process.stdout.off("resize", resize); process.stdin.off("data", input); process.stdin.off("end", stop);
    emergencyCleanup();
    if (process.platform !== "win32") { try { unlinkSync(endpoint); } catch {} }
    screen.dispose();
    await new Promise<void>((resolve) => process.stdout.write("\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1049l", () => resolve()));
    process.stdin.setRawMode(false);
    process.stdin.unref();
  }
}
