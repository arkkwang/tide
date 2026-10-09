import { createConnection, createServer, type Socket } from "node:net";
import { listenEndpoint } from "./endpoints.js";
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
  await listenEndpoint(server, record.endpoint);
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

// The two ways a record can fail without a session being reached: the endpoint is
// gone (the dead record is removed) or the request failed with no known outcome.
type Unreachable = { id: string; stale: true } | { id: string; error: { message: string } };

// Contact one endpoint independently so one unreachable host cannot block others.
async function contact<T>(registry: Registry, record: SessionRecord, request: Request, timeout?: number): Promise<T | Unreachable> {
  try { return await rpc<T>(record, request, timeout); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ECONNREFUSED") return { id: record.id, error: { message: errorMessage(error) } };
    try {
      registry.remove(record.id);
      return { id: record.id, stale: true };
    } catch (cleanupError) { return { id: record.id, error: { message: errorMessage(cleanupError) } }; }
  }
}

// Snapshot this registry once: sessions started later are not part of this close.
export async function closeAllSessions(registry = new Registry()) {
  return Promise.all(registry.records().map((record) => contact<{ id: string; closing: true }>(registry, record, { command: "close" })));
}

// --idle closes only sessions whose shell is waiting at a prompt: no foreground
// command in flight and no display attached. A session whose shell emits no
// prompt markers stays unknown and is never closed here, because a screen that
// has stopped changing cannot tell a finished task from a silent one.
export async function closeIdleSessions(registry = new Registry()) {
  return Promise.all(registry.records().map(async (record) => {
    const info = await contact<SessionInfo>(registry, record, { command: "info" }, 1000);
    if ("error" in info || "stale" in info) return info;
    if (info.display !== "detached") return { id: record.id, skipped: "attached" as const };
    if (info.promptState !== "at-prompt") return { id: record.id, skipped: info.promptState === "running" ? "command-running" as const : "prompt-unknown" as const };
    return await contact<{ id: string; closing: true }>(registry, record, { command: "close" });
  }));
}

export async function sessionRecord(prefix: string, registry = new Registry()): Promise<SessionRecord> {
  const exact = registry.records().find((record) => record.id === prefix);
  if (exact) return exact;
  const sessions = await liveSessions(registry);
  return resolveSession(sessions.map(({ record }) => record), prefix);
}

export async function requestSession<T = unknown>(prefix: string, request: Request, registry = new Registry()): Promise<T> {
  return rpc<T>(await sessionRecord(prefix, registry), request);
}
