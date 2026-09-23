import { createConnection, createServer, type Socket } from "node:net";
import { chmodSync } from "node:fs";
import { Registry, resolveSession } from "./registry.js";
import { errorMessage, type Request, type SessionInfo, type SessionRecord } from "./types.js";
import { validateWait } from "../terminal/idle.js";

const MAX_BYTES = 4 * 1024 * 1024;
export function rpc<T = unknown>(record: SessionRecord, request: Request, timeout = request.command === "wait-idle" ? request.timeout * 1000 + 2000 : 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(record.endpoint);
    let body = "", settled = false, connected = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(Error(`Request timed out${connected ? "; delivery may be unknown, do not automatically resend" : " before connecting"}`)), timeout);
    socket.setEncoding("utf8");
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(Error("Connection closed without a response; delivery may be unknown")));
    socket.on("connect", () => { connected = true; socket.write(JSON.stringify({ ...request, token: record.token }) + "\n"); });
    socket.on("data", (data: string) => {
      body += data;
      if (Buffer.byteLength(body) > MAX_BYTES) return finish(Error("Response too large"));
      if (!body.includes("\n")) return;
      try {
        const response = JSON.parse(body.split("\n")[0]!);
        if (response.ok !== true) finish(Error(response.error ?? "Request failed"));
        else finish(undefined, response.result as T);
      } catch (error) { finish(Error(errorMessage(error))); }
    });
  });
}

export async function listen(record: SessionRecord, handle: (request: Request, signal: AbortSignal) => Promise<unknown>) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let timer = setTimeout(() => socket.destroy(), 10000);
    const controller = new AbortController();
    socket.on("close", () => { clearTimeout(timer); controller.abort(); });
    let body = "";
    socket.on("data", async (data: string) => {
      body += data;
      if (Buffer.byteLength(body) > MAX_BYTES) return socket.destroy();
      if (!body.includes("\n")) return;
      socket.removeAllListeners("data");
      try {
        const request = JSON.parse(body.split("\n")[0]!);
        if (request.token !== record.token) throw Error("Unauthorized");
        if (request.command === "wait-idle") {
          validateWait(request.idleTime, request.timeout);
          clearTimeout(timer);
          timer = setTimeout(() => socket.destroy(), request.timeout * 1000 + 2000);
        }
        const result = await handle(request as Request, controller.signal);
        socket.end(JSON.stringify({ ok: true, result }) + "\n");
      } catch (error) { socket.end(JSON.stringify({ ok: false, error: errorMessage(error) }) + "\n"); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(record.endpoint, resolve); });
  if (process.platform !== "win32") chmodSync(record.endpoint, 0o600);
  return () => { for (const socket of sockets) socket.destroy(); server.close(); };
}

export async function liveSessions(registry = new Registry()): Promise<Array<{ record: SessionRecord; info: SessionInfo }>> {
  const results = await Promise.all(registry.records().map(async (record) => {
    try { return { record, info: await rpc<SessionInfo>(record, { command: "info" }, 1000) }; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") { registry.remove(record.id); return null; }
      // Do not turn a busy/unreachable session into a different unique-prefix match.
      throw Error(`Cannot verify session ${record.id}: ${errorMessage(error)}`);
    }
  }));
  return results.filter((entry) => entry !== null);
}

export async function requestSession<T = unknown>(prefix: string, request: Request, registry = new Registry()): Promise<T> {
  const exact = registry.records().find((record) => record.id === prefix);
  if (exact) return rpc<T>(exact, request);
  const sessions = await liveSessions(registry);
  const selected = resolveSession(sessions.map(({ record }) => record), prefix);
  return rpc<T>(selected, request);
}
