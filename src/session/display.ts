import { createServer, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { displayEndpoint, listenEndpoint } from "./endpoints.js";
import { validateSize } from "../terminal/resize.js";
import { errorMessage, type SessionRecord } from "./types.js";
export { displayEndpoint } from "./endpoints.js";

export type DisplayState = "detached" | "opening" | "attached";
export type DisplayEvent =
  | { event: "ready"; data: string }
  | { event: "output"; data: string }
  | { event: "resize"; cols: number; rows: number }
  | { event: "exit"; code: number }
  | { event: "error"; message: string };
const MAX_BYTES = 4 * 1024 * 1024;

// The host owns the only display slot. Reservation and connection transitions are
// synchronous; terminal state transfer runs on the host's output queue.
export class Display {
  private ticket: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private socket: Socket | undefined;
  private ready = false;
  private readonly sockets = new Set<Socket>();
  private server: ReturnType<typeof createServer> | undefined;

  constructor(private readonly record: SessionRecord, private readonly hooks: {
    // install must run inside the same queue as PTY output, after snapshot creation.
    connect: (cols: number, rows: number, install: (data: string) => void) => Promise<void>;
    input: (data: string) => Promise<void>;
    resize: (cols: number, rows: number) => Promise<void>;
  }, private readonly reservationMs = 15000) {}

  get state(): DisplayState { return this.ready ? "attached" : this.ticket ? "opening" : "detached"; }

  reserve() {
    if (this.state !== "detached") throw Error("Session already has an attached or opening terminal");
    const ticket = this.ticket = randomBytes(32).toString("hex");
    this.timer = setTimeout(() => this.cancel(ticket), this.reservationMs);
    return { ticket };
  }

  status(ticket: string): DisplayState {
    if (ticket !== this.ticket) throw Error("Display reservation expired or disconnected");
    return this.state;
  }

  cancel(ticket: string) {
    if (ticket !== this.ticket || this.ready) return;
    const socket = this.socket;
    this.release();
    socket?.destroy();
  }

  private release() {
    clearTimeout(this.timer);
    this.timer = undefined; this.ticket = undefined; this.socket = undefined; this.ready = false;
  }

  private send(socket: Socket, event: DisplayEvent) {
    // A stalled viewer must not block the shell or accumulate unbounded output.
    const frame = JSON.stringify(event) + "\n";
    if (socket.destroyed || socket.writableLength + Buffer.byteLength(frame) > MAX_BYTES) {
      socket.destroy(); return;
    }
    socket.write(frame);
  }

  output(data: string) { if (this.ready && this.socket) this.send(this.socket, { event: "output", data }); }
  requestResize(cols: number, rows: number) {
    if (!this.ready || !this.socket) throw Error("Session has no attached terminal");
    this.send(this.socket, { event: "resize", cols, rows });
  }

  async start() {
    this.server = createServer(socket => {
      this.sockets.add(socket);
      socket.setEncoding("utf8");
      socket.on("error", () => {});
      const handshakeTimer = setTimeout(() => socket.destroy(), 5000);
      socket.on("close", () => {
        clearTimeout(handshakeTimer); this.sockets.delete(socket);
        if (this.socket === socket) this.release();
      });
      let body = "", authenticated = false, failed = false, queuedBytes = 0;
      let queue = Promise.resolve();
      socket.on("data", (chunk: string) => {
        if (failed) return;
        body += chunk;
        if (Buffer.byteLength(body) + queuedBytes > MAX_BYTES) { failed = true; socket.destroy(); return; }
        let newline: number;
        while ((newline = body.indexOf("\n")) >= 0) {
          const frame = body.slice(0, newline); body = body.slice(newline + 1);
          const bytes = Buffer.byteLength(frame); queuedBytes += bytes;
          queue = queue.then(async () => {
            if (socket.destroyed || failed) return;
            const message = JSON.parse(frame);
            if (!authenticated) {
              if (message.token !== this.record.token || typeof message.ticket !== "string" || message.ticket !== this.ticket) throw Error("Unauthorized display connection");
              if (this.socket) throw Error("Session already has an attached terminal");
              validateSize(message.cols, message.rows);
              authenticated = true; this.socket = socket;
              clearTimeout(handshakeTimer);
              await this.hooks.connect(message.cols, message.rows, data => {
                if (socket.destroyed || this.socket !== socket) return;
                this.send(socket, { event: "ready", data });
                this.ready = !socket.destroyed;
                clearTimeout(this.timer);
              });
              return;
            }
            if (this.socket !== socket || !this.ready) throw Error("Display disconnected");
            if (message.command === "input") {
              if (typeof message.data !== "string" || Buffer.byteLength(message.data) > 65536) throw Error("Invalid display input");
              await this.hooks.input(message.data);
            } else if (message.command === "resize") {
              validateSize(message.cols, message.rows);
              await this.hooks.resize(message.cols, message.rows);
            } else throw Error("Unknown display message");
          }).catch(error => {
            failed = true;
            this.send(socket, { event: "error", message: errorMessage(error) });
            socket.end();
          }).finally(() => { queuedBytes -= bytes; });
        }
      });
    });
    await listenEndpoint(this.server, displayEndpoint(this.record));
  }

  dispose(code = 0) {
    clearTimeout(this.timer);
    for (const socket of this.sockets) {
      this.send(socket, { event: "exit", code });
      socket.end();
      // Do not let an unresponsive viewer keep a dead host alive.
      const timer = setTimeout(() => socket.destroy(), 1000); timer.unref();
    }
    this.server?.close();
    this.release();
  }
}
