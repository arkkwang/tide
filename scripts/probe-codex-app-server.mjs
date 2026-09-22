import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";

// Run from Git Bash: node --experimental-websocket scripts/probe-codex-app-server.mjs
// --turns additionally makes model requests using the configured default model.
if (process.argv.includes("--native") && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("--native requires a real interactive terminal; run this script from Git Bash on Windows or Terminal on macOS");
const directory = resolve(".tide/app-server-probe");
mkdirSync(directory, { recursive: true });
const binary = process.env.CODEX_BIN ?? "codex";
let endpoint = "ws://127.0.0.1:0";
const report = { endpoint, checks: [], threadId: null, model: null, error: null };
const check = (name, detail) => { report.checks.push({ name, detail }); console.log(JSON.stringify({ name, detail })); };
const server = spawn(binary, ["app-server", "--listen", endpoint], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RUST_LOG: "codex_app_server=debug" } });
let serverLog = "";
server.stdout.on("data", (s) => { serverLog += s; });
server.stderr.on("data", (s) => { serverLog += s; });
server.on("error", (e) => { serverLog += e.message; });

class Client {
  events = [];
  pending = new Map();
  seq = 0;
  constructor(socket) {
    this.socket = socket;
    socket.addEventListener("message", ({ data }) => {
      const m = JSON.parse(data);
      if (m.id !== undefined && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.timer);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else if (m.id !== undefined && m.method) {
        // The probe never grants permission requests on behalf of the user.
        socket.send(JSON.stringify({ id: m.id, error: { code: -32601, message: "Probe does not handle interactive requests" } }));
      } else this.events.push(m);
    });
    socket.addEventListener("close", () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Connection closed")); }
      this.pending.clear();
    });
  }
  async initialize(name) {
    await this.call("initialize", { clientInfo: { name, version: "0.1.0" }, capabilities: { experimentalApi: true } });
    this.socket.send(JSON.stringify({ method: "initialized", params: {} }));
  }
  call(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async event(method, predicate = () => true, timeout = 45_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const event = this.events.find((e) => e.method === method && predicate(e.params));
      if (event) return event.params;
      await sleep(50);
    }
    throw new Error(`No ${method} event within ${timeout}ms`);
  }
  close() { this.socket.close(); }
}

async function connect(name) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });
  const client = new Client(socket);
  await client.initialize(name);
  return client;
}

let owner, observer, terminal;
try {
  for (let i = 0; !serverLog.includes("listening on:"); i++) {
    if (server.exitCode !== null || i > 100) throw new Error(`App Server startup failed: ${serverLog}`);
    await sleep(100);
  }
  endpoint = /listening on: (ws:\/\/[^\s]+)/.exec(serverLog)[1];
  report.endpoint = endpoint;
  owner = await connect("tide_probe_owner");
  observer = await connect("tide_probe_observer");
  check("two-clients", true);
  const started = await owner.call("thread/start", { cwd: directory, sandbox: "read-only", approvalPolicy: "never" });
  let id = report.threadId = started.thread.id;
  report.model = started.model;
  await owner.call("thread/inject_items", { threadId: id, items: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "Tide integration probe. No repository work is requested." }] }] });
  const joined = await observer.call("thread/resume", { threadId: id });
  assert.equal(joined.thread.id, id);
  const state = await observer.call("thread/read", { threadId: id });
  check("shared-runtime-state", { status: state.thread.status, canAcceptDirectInput: state.thread.canAcceptDirectInput });
  assert.notEqual(state.thread.status.type, "notLoaded");
  const input = (text) => [{ type: "text", text }];
  assert.equal((await observer.call("thread/queue/list", { threadId: id })).data.length, 0);
  check("queue-read", true);

  if (process.argv.includes("--native")) {
    terminal = spawn(binary, ["--remote", endpoint, "--no-alt-screen", "resume", id], {
      stdio: "inherit", env: { ...process.env, TERM: process.env.TERM && process.env.TERM !== "dumb" ? process.env.TERM : "xterm-256color" },
    });
    let launchError;
    terminal.on("error", (error) => { launchError = error; });
    const deadline = Date.now() + 30_000;
    let methods = [];
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (terminal.exitCode !== null) throw new Error("Native terminal exited before joining");
      // Diagnostic evidence only; not a Tide control transport.
      const rows = serverLog.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
      methods = [...new Set(rows.filter((r) => r.span?.["app_server.client_name"] === "codex-tui" && r.fields?.message === "close").map((r) => r.span["rpc.method"]))];
      if (methods.includes("thread/resume") && methods.includes("thread/items/list")) break;
      await sleep(250);
    }
    assert.ok(methods.includes("thread/resume") && methods.includes("thread/items/list"), "Native TUI has not joined; check its trust or permission prompt");
    check("native-tui-connected", { methods });
  }

  if (process.argv.includes("--turns")) {
    const first = await owner.call("turn/start", { threadId: id, input: input("Do not use tools or read files. Reply exactly TIDE_PROBE_READY."), effort: "low" });
    const completed = await observer.event("turn/completed", (p) => p.threadId === id && p.turn.id === first.turn.id);
    assert.equal(completed.turn.status, "completed", JSON.stringify(completed.turn.error));
    const items = await observer.call("thread/items/list", { threadId: id, limit: 20, sortDirection: "desc" });
    check("completed-turn-and-snapshot", { status: completed.turn.status, items: items.data.map((x) => x.type ?? x.item?.type) });
    const second = await owner.call("turn/start", { threadId: id, input: input("Do not use tools. Count from 1 to 10000, one number per line."), effort: "low" });
    await observer.event("turn/started", (p) => p.threadId === id && p.turn.id === second.turn.id);
    await observer.call("thread/queue/add", { threadId: id, input: input("Reply TIDE_QUEUED only."), clientUserMessageId: randomUUID() });
    const queue = await owner.call("thread/queue/list", { threadId: id });
    assert.equal(queue.data.length, 1);
    check("queue-during-active-turn", { count: queue.data.length });
    await owner.call("thread/queue/delete", { threadId: id, queuedSubmissionId: queue.data[0].id });
    if (terminal) {
      terminal.kill("SIGKILL"); terminal = null;
      const afterTerminal = await observer.call("thread/read", { threadId: id });
      check("native-exit-during-turn", afterTerminal.thread.status);
      assert.equal(afterTerminal.thread.status.type, "active");
    }
    await observer.call("turn/interrupt", { threadId: id, turnId: second.turn.id });
    const interrupted = await owner.event("turn/completed", (p) => p.threadId === id && p.turn.id === second.turn.id);
    assert.equal(interrupted.turn.status, "interrupted");
    check("cross-client-interrupt", interrupted.turn.status);
  }
  owner.close(); owner = null;
  const read = await observer.call("thread/read", { threadId: id });
  check("owner-disconnect", { status: read.thread.status });
  observer.close();
  observer = await connect("tide_probe_reconnected");
  const reconnected = await observer.call("thread/read", { threadId: id });
  check("observer-reconnect", { status: reconnected.thread.status });
  assert.notEqual(reconnected.thread.status.type, "notLoaded");
  if (terminal) await sleep(3000);
} catch (error) {
  report.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  owner?.close(); observer?.close();
  server.kill("SIGKILL");
  server.stdout.destroy(); server.stderr.destroy();
  terminal?.kill("SIGKILL");
  writeFileSync(resolve(directory, "result.json"), JSON.stringify(report, null, 2));
  writeFileSync(resolve(directory, "server.log"), serverLog);
  setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
}
