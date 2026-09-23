import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import type { ShellOptions } from "../session/types.js";

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
  const name = basename(shell).replace(/\.exe$/i, "");
  const args = options.args ?? (["bash", "zsh", "sh", "fish"].includes(name) ? ["-il"] : ["pwsh", "powershell"].includes(name) ? ["-NoLogo"] : name === "cmd" ? ["/Q"] : []);
  return { shell, args, cwd: resolve(options.cwd || process.cwd()) };
}
