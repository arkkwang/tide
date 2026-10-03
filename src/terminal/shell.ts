import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import type { ShellOptions } from "../session/types.js";

const shellName = (shell: string) => basename(shell).replace(/\.exe$/i, "").toLowerCase();

// The in-shell marker that identifies a Tide session. bash runs PROMPT_COMMAND
// before every prompt, so the marker survives startup files that replace PS1:
// Git Bash's /etc/profile.d/git-prompt.sh overwrites PS1 unconditionally in login
// shells, discarding an inherited PS1 and MSYS2_PS1 alike. Other shells have no
// environment hook for the prompt, so they keep their own prompt.
// The marker is plain text, without color codes, and joins the prompt's own first
// line: git-prompt starts PS1 with a newline escape, so prepending would add a line.
export function promptEnv(shell: string, id: string, inherited = process.env.PROMPT_COMMAND): Record<string, string> {
  if (shellName(shell) !== "bash") return {};
  const marker = `T${id.slice(0, 8)}`;
  // Decoded, the injected command reads (marker for id 3c3375b9-…):
  //   case "$PS1" in *"T3c3375b9"*) ;; *'\n'*) PS1="${PS1/\\n/\\nT3c3375b9 }" ;; *) PS1="T3c3375b9 $PS1" ;; esac
  const add = `case "$PS1" in *"${marker}"*) ;; *'\\n'*) PS1="\${PS1/\\\\n/\\\\n${marker} }" ;; *) PS1="${marker} $PS1" ;; esac`;
  return { PROMPT_COMMAND: inherited ? `${add}; ${inherited}` : add };
}

export function shellCommand(options: ShellOptions) {
  let shell = options.shell || process.env.TIDE_SHELL || process.env.SHELL;
  if (!shell && process.platform === "win32") shell = process.env.CLAUDE_CODE_GIT_BASH_PATH
    || spawnSync("where.exe", ["bash.exe"], { encoding: "utf8", windowsHide: true }).stdout?.split(/\r?\n/).find((p) => p && !/WindowsApps/i.test(p))
    || process.env.ComSpec || "powershell.exe";
  shell ||= "/bin/sh";
  if (process.platform === "win32") {
    const drivePath = /^\/([a-z])\/(.*)$/i.exec(shell);
    if (drivePath) shell = `${drivePath[1]}:/${drivePath[2]}`;
    if (shell === "/bin/bash" || shell === "/usr/bin/bash") shell = "bash.exe";
  }
  const name = shellName(shell);
  const args = options.args ?? (["bash", "zsh", "sh", "fish"].includes(name) ? ["-il"] : ["pwsh", "powershell"].includes(name) ? ["-NoLogo"] : name === "cmd" ? ["/Q"] : []);
  return { shell, args, cwd: resolve(options.cwd || process.cwd()) };
}
