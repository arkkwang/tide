import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Registry, validateId } from "./registry.js";
import { rpc, sessionRecord } from "./ipc.js";
import { windowsTerminalProfile } from "../terminal/windows-profile.js";
import type { SessionInfo, ShellOptions } from "./types.js";

const shQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function launchCommand(platform: string, node: string, entry: string, id: string, cwd: string, script: string, windows?: { state: string; profile?: string | undefined; ticket?: string }) {
  if (platform === "win32") {
    if (!windows) throw Error("Windows launch requires a state directory");
    // -w 0 targets the most recently used window on this desktop: a new tab there, or a new
    // window when none exists. -w new would override the user's windowingBehavior setting.
    const args = ["-w", "0", "new-tab", ...(windows.profile ? ["--profile", windows.profile] : []), "--startingDirectory", cwd, node, entry, "__view", id, windows.state, windows.ticket ?? ""];
    // wt parses semicolons as command separators even without a shell.
    return { binary: "wt.exe", args: args.map((arg) => arg.replaceAll(";", "\\;")) };
  }
  if (platform === "darwin") return { binary: "open", args: ["-a", "Terminal", script] };
  throw Error("Opening a terminal supports Windows and macOS; use tide run in your current terminal");
}

function handoffPath(id: string, state: string) { return join(state, "terminal-launches", `${validateId(id)}.json`); }

export function consumeLaunch(id: string, state = new Registry().state): ShellOptions {
  const path = handoffPath(id, state);
  const options = JSON.parse(readFileSync(path, "utf8")) as ShellOptions;
  unlinkSync(path);
  return options;
}

export async function launchSession(options: ShellOptions): Promise<SessionInfo> {
  const registry = new Registry();
  const id = randomUUID();
  const cwd = resolve(options.cwd || process.cwd());
  const path = handoffPath(id, registry.state);
  const logs = join(registry.state, "session-logs");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const logPath = join(logs, `${id}.log`);
  mkdirSync(join(registry.state, "terminal-launches"), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ ...options, cwd }), { mode: 0o600, flag: "wx" });
  try {
    const log = openSync(logPath, "wx", 0o600);
    let started: ReturnType<typeof spawn>;
    try {
      started = spawn(process.execPath, [resolve(process.argv[1]!), "__host", id, registry.state], {
        detached: true, windowsHide: true, stdio: ["ignore", "ignore", log],
        env: { ...process.env, TIDE_STATE_DIR: registry.state },
      });
      await new Promise<void>((resolve, reject) => { started.once("spawn", resolve); started.once("error", reject); });
      started.unref();
    } finally { closeSync(log); }
    let ended = false;
    started.once("exit", () => { ended = true; });
    for (let attempt = 0; attempt < 100; attempt++) {
      const record = registry.records().find((record) => record.id === id);
      if (record) return await rpc<SessionInfo>(record, { command: "info" });
      if (ended) throw Error(`Background host exited during startup: ${id}. See ${logPath}: ${readFileSync(logPath, "utf8").slice(-2000)}`);
      await sleep(100);
    }
    throw Error(`Background host did not register within 10 seconds: ${id}. It may still be starting; check tide list and ${logPath}.`);
  } finally {
    try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

// Opens a viewer, not a new shell. Reserving before opening the window prevents
// simultaneous attach requests from creating competing tabs.
export async function attachSession(prefix: string) {
  if (!["win32", "darwin"].includes(process.platform)) throw Error("Opening a display supports Windows and macOS");
  const registry = new Registry();
  const record = await sessionRecord(prefix, registry);
  const { ticket } = await rpc<{ ticket: string }>(record, { command: "attach-reserve" });
  const script = join(registry.state, "terminal-launches", `${record.id}-${ticket}.command`);
  try {
    const command = launchCommand(process.platform, process.execPath, resolve(process.argv[1]!), record.id, registry.state, script,
      { state: registry.state, profile: process.platform === "win32" ? windowsTerminalProfile() : undefined, ticket });
    if (process.platform === "darwin") {
      mkdirSync(join(registry.state, "terminal-launches"), { recursive: true, mode: 0o700 });
      writeFileSync(script, `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(resolve(process.argv[1]!))} __view ${record.id} ${shQuote(registry.state)} ${ticket}\n`, { mode: 0o700, flag: "wx" });
    }
    const started = spawnSync(command.binary, command.args, { windowsHide: false, encoding: "utf8", timeout: 10000 });
    if (started.error || started.status !== 0) throw Error(`Cannot open terminal: ${started.error?.message ?? started.stderr}`);
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await rpc<{ display: string }>(record, { command: "attach-status", ticket });
      if (status.display === "attached") return { id: record.id, attached: true };
      await sleep(100);
    }
    throw Error("Terminal did not attach within 10 seconds; the session is still running");
  } finally {
    // Cancels only an opening reservation, never a successfully attached viewer.
    try { await rpc(record, { command: "attach-cancel", ticket }); } catch {}
    try { unlinkSync(script); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
