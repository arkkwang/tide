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
// The case statement that keeps `marker` in front of the prompt. Decoded, for
// id 3c3375b9-… it reads:
//   case "$PS1" in *"T3c3375b9"*) ;; *'\n'*) PS1="${PS1/\\n/\\nT3c3375b9 }" ;; *) PS1="T3c3375b9 $PS1" ;; esac
const markerCase = (marker: string) => `case "$PS1" in *"${marker}"*) ;; *'\\n'*) PS1="\${PS1/\\\\n/\\\\n${marker} }" ;; *) PS1="${marker} $PS1" ;; esac`;

export function promptEnv(shell: string, id: string, inherited = process.env.PROMPT_COMMAND): Record<string, string> {
  if (shellName(shell) !== "bash") return {};
  const marker = `T${id.slice(0, 8)}`;
  // A session opened inside another Tide session inherits the marker and the
  // case statement that keeps it. Drop each prior case so it cannot re-add
  // its marker on every prompt, and strip the marker it left in PS1 so the
  // prompt shows only the current session id.
  const prior = [...new Set([...(inherited ?? "").matchAll(/in \*"T([0-9a-fA-F]{8})"\*/g)].map((m) => `T${m[1]}`))].filter((m) => m !== marker);
  // The cases are always their own `;`-separated statements, so drop them
  // together with that separator instead of leaving a dangling `;` behind,
  // which would make bash reject the whole PROMPT_COMMAND.
  let cleaned = (inherited ?? "").trim();
  for (const m of prior) {
    const c = markerCase(m);
    if (cleaned.startsWith(c)) cleaned = cleaned.slice(c.length);
    cleaned = cleaned.split(`; ${c}`).join("");
  }
  cleaned = cleaned.replace(/^;/, "").trimStart();
  const strip = prior.map((m) => `PS1="\${PS1//${m} }"`).join("; ");
  const add = `${strip ? `${strip}; ` : ""}${markerCase(marker)}`;
  return { PROMPT_COMMAND: cleaned ? `${add}; ${cleaned}` : add };
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

// Bash expands PS0 immediately before execution (4.4+). PS1 marks the beginning
// of the whole prompt, including multi-line prompts. No DEBUG trap or command
// rewriting: interactive programs and user input keep their existing behavior.
export function commandRegionEnv(shell: string, prompt: Record<string, string>): Record<string, string> {
  if (shellName(shell) !== "bash") return prompt;
  const hook = String.raw`case "$PS1" in *'\e]133;A\a'*) ;; *) PS1='\[\e]133;A\a\]'"$PS1" ;; esac; case "$PS1" in *'\e]133;B\a'*) ;; *) PS1="$PS1"'\[\e]133;B\a\]' ;; esac; case "$PS0" in *'\e]133;C\a'*) ;; *) PS0='\e]133;C\a'"$PS0" ;; esac`;
  const inherited = prompt.PROMPT_COMMAND ?? "";
  return { ...prompt, PROMPT_COMMAND: inherited.includes(hook) ? inherited : `${inherited}${inherited ? "; " : ""}${hook}` };
}
