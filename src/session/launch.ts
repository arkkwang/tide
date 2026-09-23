import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Registry, validateId } from "./registry.js";
import { rpc } from "./ipc.js";
import type { SessionInfo, ShellOptions } from "./types.js";

const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const shQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function launchCommand(platform: string, node: string, entry: string, id: string, cwd: string, script: string) {
  if (platform === "win32") {
    const args = `"${entry}" __host ${id}`;
    const command = `Start-Process -FilePath ${psQuote(node)} -ArgumentList ${psQuote(args)} -WorkingDirectory ${psQuote(cwd)} -WindowStyle Normal`;
    return { binary: "powershell.exe", args: ["-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")] };
  }
  if (platform === "darwin") return { binary: "open", args: ["-a", "Terminal", script] };
  throw Error("New-window launch supports Windows and macOS; use tide run in your current terminal");
}

function handoffPath(id: string, state: string) { return join(state, "terminal-launches", `${validateId(id)}.json`); }

export function consumeLaunch(id: string): ShellOptions {
  const state = new Registry().state;
  const path = handoffPath(id, state);
  const request = JSON.parse(readFileSync(path, "utf8")) as { options: ShellOptions; env: NodeJS.ProcessEnv };
  unlinkSync(path);
  try { unlinkSync(path.replace(/\.json$/, ".command")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Terminal.app may already be running with a different environment.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, request.env);
  return request.options;
}

export async function launchSession(options: ShellOptions): Promise<SessionInfo> {
  const registry = new Registry();
  const id = randomUUID();
  const cwd = resolve(options.cwd || process.cwd());
  const path = handoffPath(id, registry.state);
  const script = path.replace(/\.json$/, ".command");
  const command = launchCommand(process.platform, process.execPath, resolve(process.argv[1]!), id, cwd, script);
  mkdirSync(join(registry.state, "terminal-launches"), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ options: { ...options, cwd }, env: { ...process.env, TIDE_STATE_DIR: registry.state } }), { mode: 0o600, flag: "wx" });
  try {
    if (process.platform === "darwin") writeFileSync(script, `#!/bin/sh\nexport TIDE_STATE_DIR=${shQuote(registry.state)}\nexec ${shQuote(process.execPath)} ${shQuote(resolve(process.argv[1]!))} __host ${id}\n`, { mode: 0o700, flag: "wx" });
    const started = spawnSync(command.binary, command.args, { windowsHide: true, encoding: "utf8", timeout: 10000 });
    if (started.error || started.status !== 0) throw Error(started.error?.message ?? started.stderr);
    for (let attempt = 0; attempt < 100; attempt++) {
      const record = registry.records().find((record) => record.id === id);
      if (record) return await rpc<SessionInfo>(record, { command: "info" });
      await sleep(100);
    }
    throw Error(`Terminal did not register within 10 seconds: ${id}. Inspect the opened window; do not blindly relaunch.`);
  } finally {
    for (const file of [path, script]) { try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  }
}
