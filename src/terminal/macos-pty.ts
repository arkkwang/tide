import { accessSync, chmodSync, constants, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

// node-pty 1.1.0 chooses Release, Debug, then the architecture's prebuild.
// Reuse its loader instead of guessing which helper is next to the loaded addon.
// This private API is isolated here and must be checked when upgrading node-pty.
function helperPath(): string {
  const require = createRequire(import.meta.url);
  const { loadNativeModule } = require("node-pty/lib/utils.js") as {
    loadNativeModule(name: string): { dir: string };
  };
  return resolve(dirname(require.resolve("node-pty/lib/unixTerminal.js")), loadNativeModule("pty").dir, "spawn-helper");
}

export function ensureExecutableHelper(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw Error("expected a regular file, not a directory or symlink");
    try { accessSync(path, constants.X_OK); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error; }
    // Add only owner execute; preserve all other permission bits. Never sudo,
    // recursively chmod the package, or replace/download a missing executable.
    chmodSync(path, (stat.mode & 0o7777) | 0o100);
    accessSync(path, constants.X_OK);
  } catch (error) {
    throw Error(`Cannot prepare node-pty spawn-helper at ${path}: ${error instanceof Error ? error.message : String(error)}. Reinstall node-pty if the helper is missing; otherwise check its ownership and execute permission (chmod u+x on this file).`, { cause: error });
  }
}

export function prepareMacPty(platform = process.platform, locateHelper = helperPath): void {
  if (platform !== "darwin") return;
  let path: string;
  try { path = locateHelper(); }
  catch (error) { throw Error("Cannot locate the macOS node-pty spawn-helper. Reinstall node-pty for this Node architecture.", { cause: error }); }
  ensureExecutableHelper(path);
}
