import { spawnSync } from "node:child_process";

export function configureWindowsConsole(): void {
  if (process.platform !== "win32") return;
  // Node initializes its TTY output mode lazily; do that before setting ours.
  void process.stdout.isTTY;
  const script = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TideConsoleMode {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(IntPtr h, out uint mode);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(IntPtr h, uint mode);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleOutputCP(uint codePage);
}
'@
$outputHandle = [TideConsoleMode]::GetStdHandle(-11)
$outputMode = 0
if (-not [TideConsoleMode]::GetConsoleMode($outputHandle, [ref]$outputMode)) { throw 'Cannot read console output mode' }
$inputHandle = [TideConsoleMode]::GetStdHandle(-10)
$inputMode = 0
if (-not [TideConsoleMode]::GetConsoleMode($inputHandle, [ref]$inputMode)) { throw 'Cannot read console input mode' }
if (-not [TideConsoleMode]::SetConsoleMode($inputHandle, ($inputMode -bor 512))) { throw 'Cannot enable VT input' }
if (-not [TideConsoleMode]::SetConsoleMode($outputHandle, ($outputMode -bor 12))) { throw 'Cannot configure VT output' }
if (-not [TideConsoleMode]::SetConsoleOutputCP(65001)) { throw 'Cannot configure UTF-8 output' }
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    // Raw input needs VT reports; VT output needs LF to preserve its column.
    // Inherit both console handles; pipes have no console mode.
    stdio: ["inherit", "inherit", "pipe"], windowsHide: true, encoding: "utf8", timeout: 10000,
  });
  if (result.error || result.status !== 0) throw Error(`Cannot configure Windows terminal modes: ${result.error?.message ?? result.stderr.trim()}`);
}
