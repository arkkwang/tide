import { createConnection } from "node:net";
import { Registry } from "./registry.js";
import { sessionRecord } from "./ipc.js";
import { displayEndpoint, type DisplayEvent } from "./display.js";
import { writeTerminalOutput } from "../terminal/output.js";
import { configureWindowsConsole } from "../terminal/windows-console.js";
import { validateSize } from "../terminal/resize.js";

// Runs only inside the newly opened terminal. Its lifetime does not own the shell.
export async function viewSession(id: string, state: string, ticket: string): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error("Display requires an interactive terminal");
  const record = await sessionRecord(id, new Registry(state));
  const size = () => ({ cols: process.stdout.columns || 100, rows: process.stdout.rows || 30 });
  validateSize(size().cols, size().rows);
  configureWindowsConsole();
  process.stdin.setEncoding("utf8"); process.stdin.setRawMode(true);
  const socket = createConnection(displayEndpoint(record));
  socket.setEncoding("utf8");
  let body = "", ready = false, exitCode = 0;
  const send = (message: object) => {
    if (socket.destroyed) return;
    if (socket.writableLength > 1024 * 1024) { socket.destroy(Error("Display input queue is full")); return; }
    socket.write(JSON.stringify(message) + "\n");
  };
  const input = (data: string) => { if (ready) send({ command: "input", data }); };
  const resize = () => { if (ready) send({ command: "resize", ...size() }); };
  const detach = () => socket.end();
  const drain = () => socket.resume();
  const timer = setTimeout(() => socket.destroy(Error("Display handshake timed out")), 10000);
  try {
    return await new Promise<number>((resolve, reject) => {
      socket.once("connect", () => send({ token: record.token, ticket, ...size() }));
      socket.once("error", reject);
      socket.once("close", () => ready ? resolve(exitCode) : reject(Error("Display closed before attachment")));
      socket.on("data", (chunk: string) => {
        try {
          body += chunk;
          if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw Error("Display frame too large");
          let newline: number;
          while ((newline = body.indexOf("\n")) >= 0) {
            const event = JSON.parse(body.slice(0, newline)) as DisplayEvent;
            body = body.slice(newline + 1);
            switch (event.event) {
              case "ready":
                writeTerminalOutput(event.data);
                ready = true; clearTimeout(timer);
                process.stdin.on("data", input); process.stdin.on("end", detach); process.stdin.resume();
                process.stdout.on("resize", resize);
                break;
              case "output": writeTerminalOutput(event.data); break;
              case "resize": writeTerminalOutput(`\x1b[8;${event.rows};${event.cols}t`); break;
              case "exit": exitCode = event.code; socket.end(); break;
              case "error": throw Error(event.message);
              default: throw Error("Unknown display event");
            }
          }
          if (process.stdout.writableLength > 1024 * 1024) socket.pause();
        } catch (error) { socket.destroy(error instanceof Error ? error : Error(String(error))); }
      });
      process.on("SIGHUP", detach); process.on("SIGTERM", detach);
      process.stdout.on("drain", drain);
    });
  } finally {
    clearTimeout(timer); socket.destroy();
    process.off("SIGHUP", detach); process.off("SIGTERM", detach);
    process.stdout.off("resize", resize); process.stdout.off("drain", drain);
    process.stdin.off("data", input); process.stdin.off("end", detach); process.stdin.pause();
    writeTerminalOutput("\x1b[?1049l\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l");
    process.stdin.setRawMode(false); process.stdin.unref();
  }
}
