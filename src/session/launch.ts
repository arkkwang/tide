import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Registry, validateId } from "./registry.js";
import { rpc } from "./ipc.js";
import { windowsTerminalProfile } from "../terminal/windows-profile.js";
import type { SessionInfo, ShellOptions } from "./types.js";

const shQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function launchCommand(platform: string, node: string, entry: string, id: string, cwd: string, script: string, windows?: { state: string; profile?: string | undefined }) {
  if (platform === "win32") {
    if (!windows) throw Error("Windows launch requires a state directory");
    // -w 0 targets the most recently used window on this desktop: a new tab there, or a new
    // window when none exists. -w new would override the user's windowingBehavior setting.
    const args = ["-w", "0", "new-tab", ...(windows.profile ? ["--profile", windows.profile] : []), "--startingDirectory", cwd, node, entry, "__host", id, windows.state];
    // wt parses semicolons as command separators even without a shell.
    return { binary: "wt.exe", args: args.map((arg) => arg.replaceAll(";", "\\;")) };
  }
  if (platform === "darwin") return { binary: "open", args: ["-a", "Terminal", script] };
  throw Error("Opening a terminal supports Windows and macOS; use tide run in your current terminal");
}

function handoffPath(id: string, state: string) { return join(state, "terminal-launches", `${validateId(id)}.json`); }

export function consumeLaunch(id: string, state = new Registry().state): ShellOptions {
  const path = handoffPath(id, state);
  const request = JSON.parse(readFileSync(path, "utf8")) as { options: ShellOptions; env: NodeJS.ProcessEnv };
  unlinkSync(path);
  try { unlinkSync(path.replace(/\.json$/, ".command")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Keep the new terminal's identity, while restoring the launching shell's environment.
  const terminalEnv = Object.fromEntries(["WT_SESSION", "WT_PROFILE_ID"].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, request.env);
  for (const key of ["WT_SESSION", "WT_PROFILE_ID"]) delete process.env[key];
  Object.assign(process.env, terminalEnv);
  return request.options;
}

export async function launchSession(options: ShellOptions): Promise<SessionInfo> {
  const registry = new Registry();
  const id = randomUUID();
  const cwd = resolve(options.cwd || process.cwd());
  const path = handoffPath(id, registry.state);
  const script = path.replace(/\.json$/, ".command");
  const command = launchCommand(process.platform, process.execPath, resolve(process.argv[1]!), id, cwd, script, { state: registry.state, profile: process.platform === "win32" ? windowsTerminalProfile() : undefined });
  mkdirSync(join(registry.state, "terminal-launches"), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ options: { ...options, cwd }, env: { ...process.env, TIDE_STATE_DIR: registry.state } }), { mode: 0o600, flag: "wx" });
  try {
    if (process.platform === "darwin") writeFileSync(script, `#!/bin/sh\nexport TIDE_STATE_DIR=${shQuote(registry.state)}\nexec ${shQuote(process.execPath)} ${shQuote(resolve(process.argv[1]!))} __host ${id}\n`, { mode: 0o700, flag: "wx" });
    const started = spawnSync(command.binary, command.args, { windowsHide: false, encoding: "utf8", timeout: 10000 });
    if (started.error || started.status !== 0) throw Error(`${command.binary} launch failed: ${started.error?.message ?? started.stderr}. ${process.platform === "win32" ? "Ensure Windows Terminal (wt.exe) is available, or use tide run in an existing terminal." : "Check your terminal installation."}`);
    for (let attempt = 0; attempt < 100; attempt++) {
      const record = registry.records().find((record) => record.id === id);
      if (record) return await rpc<SessionInfo>(record, { command: "info" });
      await sleep(100);
    }
    throw Error(`Terminal did not register within 10 seconds: ${id}. Inspect the opened tab; do not blindly relaunch.`);
  } finally {
    for (const file of [path, script]) { try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  }
}
