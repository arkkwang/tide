import { writeSync } from "node:fs";

export function writeTerminalOutput(data: string): void {
  if (process.platform !== "win32") { process.stdout.write(data); return; }
  // libuv's Windows TTY writer inserts CR before bare LF, changing VT cursor
  // positions. The file-descriptor writer preserves the PTY's byte stream.
  const bytes = Buffer.from(data, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(1, bytes, offset, bytes.length - offset);
    if (!written) throw Error("Terminal output write made no progress");
    offset += written;
  }
}
