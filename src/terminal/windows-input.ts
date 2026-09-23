import { spawnSync } from "node:child_process";

// Node 20 raw mode clears ENABLE_VIRTUAL_TERMINAL_INPUT. Without it Windows
// consumes mouse reports instead of passing them to the hosted TUI.
export function enableWindowsVTInput() {
  if (process.platform !== "win32") return;
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TideConsoleInput {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(IntPtr h, out uint mode);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(IntPtr h, uint mode);
}
'@
$handle = [TideConsoleInput]::GetStdHandle(-10)
$mode = 0
if (-not [TideConsoleInput]::GetConsoleMode($handle, [ref]$mode)) { throw 'Cannot read console input mode' }
if (-not [TideConsoleInput]::SetConsoleMode($handle, ($mode -bor 512))) { throw 'Cannot enable VT input' }
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    // Inherit the actual console input handle; a pipe has no console mode.
    stdio: ["inherit", "pipe", "pipe"], windowsHide: true, encoding: "utf8", timeout: 10000,
  });
  if (result.error || result.status !== 0) throw Error(`Cannot configure Windows terminal input: ${result.error?.message ?? result.stderr.trim()}`);
}
