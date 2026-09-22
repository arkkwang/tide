import { test } from "node:test";
import assert from "node:assert/strict";
import { Execution } from "../src/core/process.ts";
import { Sessions } from "../src/core/sessions.ts";
import type { Adapter, Session } from "../src/core/session.ts";
import { resumeSession } from "../src/features/resume.ts";
import { supervisorCommand } from "../src/providers/terminal.ts";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("macOS foreground launch preserves literal arguments without Windows shell dependencies", () => {
  const args = ["--model", "model", "spaces 中文 ' $HOME `literal`", "--permission-mode", "plan"];
  assert.deepEqual(supervisorCommand("darwin", "/usr/local/bin/node", "/Users/me/tide project/dist/tide.mjs", "claude", args), {
    binary: "/usr/local/bin/node", args: ["/Users/me/tide project/dist/tide.mjs", "__foreground", "claude", ...args],
  });
  const windows = supervisorCommand("win32", "D:\\Node JS\\node.exe", "D:\\my project\\tide.mjs", "claude", args, "D:\\Git\\bin\\bash.exe");
  assert.deepEqual(windows.args.slice(3), args);
  assert.ok(windows.args[1]!.includes('"$@"'));
  assert.throws(() => supervisorCommand("win32", "node", "tide.mjs", "claude", []), /Git Bash/);
});

const session: Session = { sessionId: "test", cwd: process.cwd(), isSubagent: false, lastAssistantAt: 1, lastEvent: "running" };
function provider(): Adapter {
  return { kind: "claude", resolveBin: () => null, findSessions: async () => [session],
    readQuota: async () => { throw new Error("Unexpected quota probe"); },
    snapshot: () => { throw new Error("unused snapshot"); },
    history: () => { throw new Error("unused history"); } };
}

test("sending never implicitly launches; explicit resume reports launch separately from delivery", async () => {
  const p = provider();
  let launches = 0;
  p.launchSession = async () => { launches++; return { ok: true, requested: true, detail: "window requested" }; };
  const core = new Sessions(p);
  assert.equal((await core.send(session, "hello")).unsupported, true);
  assert.equal(launches, 0);
  const result = await resumeSession(core, session, "continue");
  assert.equal(result.launchRequested, true);
  assert.equal(result.delivered, false);
  assert.equal(launches, 1);
});

test("immediate correction never silently becomes a queued message", async () => {
  const p = provider();
  let messages = 0;
  p.send = async () => { messages++; return { ok: true, delivered: true, via: "test", detail: "queued" }; };
  const core = new Sessions(p);
  assert.equal((await core.send(session, "stop", "interrupt")).unsupported, true);
  assert.equal(messages, 0);
  assert.equal((await core.send(session, "stop", "interrupt", true)).unsupported, true);
  assert.equal((await core.send(session, "more", "queue", true)).delivered, false);
  assert.equal(messages, 0);
  assert.equal((await core.send(session, "more", "queue")).delivered, true);
  assert.equal(messages, 1);
});

test("observation does not probe, send or recover, and cancellation wakes a long interval", async () => {
  const p = provider();
  let reads = 0;
  p.findSessions = async () => { reads++; return [session]; };
  p.send = async () => { throw new Error("Unexpected message"); };
  p.launchSession = async () => { throw new Error("Unexpected launch"); };
  const core = new Sessions(p);
  const abort = new AbortController();
  const stream = core.monitor(60_000, abort.signal);
  assert.deepEqual((await stream.next()).value, [session]);
  const pending = stream.next();
  abort.abort();
  assert.equal((await pending).done, true);
  assert.equal(reads, 1);
  assert.equal(core.state(session).currentState, "unknown");
});

test("cancellation while observation is in flight does not publish an obsolete sample", async () => {
  const p = provider();
  const abort = new AbortController();
  p.findSessions = async () => { abort.abort(); return [session]; };
  assert.equal((await new Sessions(p).monitor(1000, abort.signal).next()).done, true);
});

test("launch and stop control only the owned process handle", async () => {
  const owned = Execution.launch(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  const other = Execution.launch(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  try {
    assert.equal(owned.running, true);
    assert.equal(await owned.stop(), true);
    assert.equal(owned.running, false);
    assert.equal(other.running, true);
    assert.equal(await owned.stop(), true);
  } finally { await owned.stop(); await other.stop(); }
});

test("native launch failure rejects instead of reporting a running process", async () => {
  const execution = Execution.launch("tide-definitely-missing-executable", [], { stdio: "ignore", windowsHide: true });
  await assert.rejects(execution.exited, /ENOENT/);
  assert.equal(execution.running, false);
});

test("POSIX stop terminates an owned process that ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "tide-stop-"));
  const ready = join(dir, "ready");
  const owned = Execution.launch(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1],'ready'); setInterval(()=>{},1000)", ready], { stdio: "ignore" });
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(ready)) {
      if (Date.now() >= deadline) throw new Error("Child did not become ready");
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(await owned.stop(100), true);
    assert.equal(owned.running, false);
  } finally { await owned.stop(100); rmSync(dir, { recursive: true, force: true }); }
});
