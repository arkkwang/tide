import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { spawnDetached } from "./util.js";

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
