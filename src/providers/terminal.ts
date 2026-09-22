import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { spawnDetached } from "../util.js";

/** Quote for a POSIX shell: single quotes, with an embedded quote closed and reopened. */
export function posixQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** MSYS hands this value to a bash child as `/d/dir/bash.exe`; cmd and CreateProcess need
 * `D:\dir\bash.exe`. Both forms reach tide depending on who launched it. */
function toWindowsPath(path: string): string {
  const msys = /^\/([a-zA-Z])\/(.*)$/.exec(path);
  return msys ? `${msys[1]!.toUpperCase()}:\\${msys[2]!.replaceAll("/", "\\")}` : path;
}

/** Git Bash, the interpreter a delivery script runs under. `where.exe` also answers with the
 * WSL stub in `WindowsApps`, which is the same name and cannot see drive letters. */
export function resolveBash(): string | null {
  if (process.platform !== "win32") return existsSync("/bin/bash") ? "/bin/bash" : null;
  const fromEnv = process.env["CLAUDE_CODE_GIT_BASH_PATH"];
  if (fromEnv) {
    const candidate = toWindowsPath(fromEnv);
    if (/^[a-zA-Z]:[\\/]/.test(candidate) && existsSync(candidate)) {
      return candidate;
    }
  }
  const which = spawnSync("where.exe", ["bash"], { encoding: "utf8", windowsHide: true });
  if (which.status === 0) {
    for (const line of (which.stdout ?? "").split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate && !/windowsapps/i.test(candidate) && existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export function supervisorCommand(platform: NodeJS.Platform, node: string, entry: string, cli: string, args: string[], bash?: string | null) {
  if (platform !== "win32") return { binary: node, args: [entry, "__foreground", cli, ...args] };
  if (!bash) throw new Error("Windows launch requires Git Bash; set CLAUDE_CODE_GIT_BASH_PATH");
  return { binary: bash, args: ["-lc", `exec ${posixQuote(node.replaceAll("\\", "/"))} ${posixQuote(entry.replaceAll("\\", "/"))} __foreground ${cli} "$@"`, "tide", ...args] };
}

export interface LaunchResult {
  ok: boolean;
  detail: string;
}

export interface LaunchRequest {
  /** Absolute path of the script the new window runs. */
  scriptPath: string;
  /** Window title; `start` reads a bare first argument as the title, so it must not be empty. */
  title: string;
  /** Where the launcher's own output goes. */
  logPath: string;
  /** Environment for the launched window; the whole environment when set. */
  env?: NodeJS.ProcessEnv;
}

/** Open `scriptPath` in a new terminal window. The Windows branch is the one exercised on this
 * machine: `start` allocates the console, Git Bash runs the script. The macOS branch is written
 * to the same contract but has not been run — `open` should make Terminal execute the script as
 * a shell script, and `env` should not reach it, because Terminal runs it under the shell
 * Terminal itself was started with. */
export function launchWindow(req: LaunchRequest): LaunchResult {
  if (process.platform === "win32") {
    const bash = resolveBash();
    if (!bash) {
      return { ok: false, detail: "no Git Bash found: set CLAUDE_CODE_GIT_BASH_PATH" };
    }
    const command = posixQuote(req.scriptPath.replaceAll("\\", "/"));
    const started = spawnDetached("cmd.exe", ["/c", "start", req.title, bash, "-lc", command], {
      logPath: req.logPath,
      ...(req.env ? { env: req.env } : {}),
    });
    return started.pid === null
      ? { ok: false, detail: started.spawnError ?? "cmd did not start" }
      : { ok: true, detail: `${bash} -lc ${command}` };
  }

  if (process.platform === "darwin") {
    const started = spawnDetached("open", ["-a", "Terminal", req.scriptPath], {
      logPath: req.logPath,
      ...(req.env ? { env: req.env } : {}),
    });
    return started.pid === null
      ? { ok: false, detail: started.spawnError ?? "open did not start" }
      : { ok: true, detail: `open -a Terminal ${req.scriptPath}` };
  }

  return { ok: false, detail: `${process.platform} has no terminal-window launcher` };
}

// Preserve safety/model/environment options on recovery. Initial launch argv are always untouched.
// Positional initial prompts and session selection flags must not be replayed as a second task.
export function claudeRecoveryArgs(args: string[], id: string, prompt: string): string[] {
  const values = new Set(["--model", "--effort", "--permission-mode", "--settings", "--setting-sources", "--agent", "--system-prompt", "--append-system-prompt", "--fallback-model"]);
  const lists = new Set(["--add-dir", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--tools", "--mcp-config", "--plugin-dir"]);
  const switches = new Set(["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--strict-mcp-config", "--disable-slash-commands", "--bare", "--safe-mode", "--restricted", "--chrome"]);
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    const name = arg.split("=", 1)[0]!;
    if (switches.has(name) || ((values.has(name) || lists.has(name)) && arg.includes("="))) kept.push(arg);
    else if (values.has(name) && args[i + 1] !== undefined) kept.push(arg, args[++i]!);
    else if (lists.has(name)) {
      kept.push(arg);
      while (args[i + 1] !== undefined && !args[i + 1]!.startsWith("-")) kept.push(args[++i]!);
    }
  }
  return [...kept, "--resume", id, "--", prompt];
}
