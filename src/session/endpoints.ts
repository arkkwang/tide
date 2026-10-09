import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:net";

// Keep the same derivation for old records and Windows named pipes.
export const displayEndpoint = (record: { endpoint: string }) => `${record.endpoint}-display`;
const MAX_SOCKET_BYTES = 103; // macOS sockaddr_un: 104 bytes including the trailing NUL.

export function validateEndpoint(endpoint: string, platform = process.platform) {
  if (platform === "win32") return;
  const bytes = Buffer.byteLength(endpoint);
  if (bytes > MAX_SOCKET_BYTES) throw Error(`Unix socket path is too long (${bytes} bytes; maximum ${MAX_SOCKET_BYTES}): ${endpoint}. Set TIDE_STATE_DIR to a shorter persistent directory.`);
}

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!()) throw Error(`Unsafe Tide directory (must be an owned directory, not a symlink): ${path}`);
  if (stat.mode & 0o077) chmodSync(path, 0o700);
}

export function sessionEndpoint(state: string, id: string) {
  if (process.platform === "win32") return { endpoint: `\\\\.\\pipe\\tide-${id}`, dispose() {} };
  const root = join(state, "sockets");
  // Check before creating anything, including the longer display endpoint.
  validateEndpoint(displayEndpoint({ endpoint: join(root, "s-XXXXXX", "rpc") }));
  privateDirectory(state);
  privateDirectory(root);
  const directory = mkdtempSync(join(root, "s-"));
  return { endpoint: join(directory, "rpc"), dispose() { rmSync(directory, { recursive: true, force: true }); } };
}

// A chmod failure after listen must not leak a listening server. Never unlink
// an existing endpoint when listen itself failed (it may belong to another host).
export async function listenEndpoint(server: Server, endpoint: string) {
  validateEndpoint(endpoint);
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.off("listening", ready); reject(error); };
      const ready = () => { server.off("error", failed); resolve(); };
      server.once("error", failed);
      server.once("listening", ready);
      server.listen(endpoint);
    });
    if (process.platform !== "win32") chmodSync(endpoint, 0o600);
  } catch (error) {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
}
