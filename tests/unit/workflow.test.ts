import { test } from "node:test";
import assert from "node:assert/strict";
import { attachOnce, assertAttachSupported, sendAndObserve, type WorkflowDeps, type WorkflowOptions } from "../../src/cli/workflow.ts";
import type { Request, SessionInfo } from "../../src/session/types.ts";

function launched(): SessionInfo {
  return { id: "s1", pid: 1, shellPid: 2, shell: "bash", cwd: "/tmp", createdAt: "2026-01-01T00:00:00.000Z", exited: false, exitCode: null, display: "detached" };
}

function options(partial: Partial<WorkflowOptions> = {}): WorkflowOptions {
  return { enter: false, wait: false, idleTime: 3, timeout: 30, read: false, full: false, ...partial };
}

function mockDeps(behavior: { sendError?: Error; enterError?: Error; attachError?: Error; idle?: boolean } = {}) {
  const calls: string[] = [];
  const deps: WorkflowDeps = {
    request: <T>(id: string, request: Request): Promise<T> => {
      calls.push(request.command);
      assert.equal(id, "s1");
      if (request.command === "send" && "keys" in request && behavior.enterError) return Promise.reject(behavior.enterError);
      if (request.command === "send" && calls.length === 1 && behavior.sendError) return Promise.reject(behavior.sendError);
      if (request.command === "wait-idle") return Promise.resolve({ idle: behavior.idle ?? true, waited: 1 }) as Promise<T>;
      if (request.command === "read") return Promise.resolve({ text: "out" }) as Promise<T>;
      return Promise.resolve({ id, written: true }) as Promise<T>;
    },
    attach: async (id: string) => {
      assert.equal(id, "s1");
      calls.push("attach");
      if (behavior.attachError) throw behavior.attachError;
    },
  };
  return { calls, deps };
}

// Captures the one JSON line plus stderr, and isolates process.exitCode per test.
async function run(fn: () => Promise<void>) {
  const logs: string[] = [], errs: string[] = [];
  const log = console.log, err = console.error, previousExitCode = process.exitCode;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { errs.push(args.join(" ")); };
  process.exitCode = undefined;
  let error: Error | undefined;
  try { await fn(); } catch (caught) { error = caught as Error; }
  finally { console.log = log; console.error = err; }
  const exitCode = process.exitCode;
  process.exitCode = previousExitCode;
  assert.ok(logs.length <= 1, "stdout must contain at most one JSON result");
  const output = () => logs.length ? JSON.parse(logs[logs.length - 1]!) : undefined;
  return { logs, errs, output, error, exitCode };
}

test("sendAndObserve attaches after Enter, before wait and read, and reports attached", async () => {
  const { calls, deps } = mockDeps();
  const { output, exitCode } = await run(() => sendAndObserve("s1", { command: "send", text: "hello" }, options({ enter: true, attach: true, wait: true, read: true }), launched(), deps));
  assert.deepEqual(calls, ["send", "send", "attach", "wait-idle", "read"]);
  const out = output();
  assert.equal(out.id, "s1");
  assert.equal(out.written, true);
  assert.equal(out.enterWritten, true);
  assert.equal(out.attached, true);
  assert.equal(out.display, "attached");
  assert.equal(out.wait.idle, true);
  assert.equal(out.read.text, "out");
  assert.equal(exitCode, undefined);
});

test("sendAndObserve without attach never calls attach", async () => {
  const { calls, deps } = mockDeps();
  const { output } = await run(() => sendAndObserve("s1", { command: "send", text: "hello" }, options({ enter: true, wait: true, read: true }), launched(), deps));
  assert.deepEqual(calls, ["send", "send", "wait-idle", "read"]);
  assert.equal(output().attached, undefined);
  assert.equal(output().display, "detached");
});

test("attach failure keeps id and acknowledged results, skips wait and read, exits 1", async () => {
  const { calls, deps } = mockDeps({ attachError: Error("wt exploded") });
  const { output, errs, exitCode } = await run(() => sendAndObserve("s1", { command: "send", text: "hello" }, options({ enter: true, attach: true, wait: true, read: true }), launched(), deps));
  assert.deepEqual(calls, ["send", "send", "attach"]);
  const out = output();
  assert.equal(out.id, "s1");
  assert.equal(out.written, true);
  assert.equal(out.enterWritten, true);
  assert.equal(out.error.stage, "attach");
  assert.equal(out.wait, undefined);
  assert.equal(out.read, undefined);
  assert.equal(exitCode, 1);
  assert.match(errs.join(" "), /tide attach s1/);
  assert.match(errs.join(" "), /was not closed/);
});

test("wait timeout after a successful attach still exits 3 and keeps attached", async () => {
  const { calls, deps } = mockDeps({ idle: false });
  const { output, exitCode } = await run(() => sendAndObserve("s1", { command: "send", text: "hello" }, options({ attach: true, wait: true }), launched(), deps));
  assert.deepEqual(calls, ["send", "attach", "wait-idle"]);
  const out = output();
  assert.equal(out.attached, true);
  assert.equal(out.display, "attached");
  assert.equal(out.wait.idle, false);
  assert.equal(exitCode, 3);
});

test("a failed initial send rejects before attach, wait or read", async () => {
  const { calls, deps } = mockDeps({ sendError: Error("send refused") });
  const { error, exitCode } = await run(() => sendAndObserve("s1", { command: "send", text: "hello" }, options({ enter: true, attach: true, wait: true, read: true }), launched(), deps));
  assert.ok(error);
  assert.equal(error!.message, "send refused");
  assert.deepEqual(calls, ["send"]);
  assert.equal(exitCode, undefined);
});

test("attachOnce success returns the session fields with attached", async () => {
  const { calls, deps } = mockDeps();
  const result = await attachOnce(launched(), deps);
  assert.deepEqual(calls, ["attach"]);
  assert.equal(result.id, "s1");
  assert.ok("attached" in result);
  assert.equal(result.attached, true);
  assert.equal(result.display, "attached");
  assert.equal("error" in result, false);
});

test("attachOnce failure preserves session fields and the error, never closing", async () => {
  const { calls, deps } = mockDeps({ attachError: Error("no display") });
  const result = await attachOnce(launched(), deps);
  assert.deepEqual(calls, ["attach"]);
  assert.equal(result.id, "s1");
  assert.ok("error" in result);
  assert.equal(result.error.stage, "attach");
  assert.equal(result.error.message, "no display");
  assert.equal(process.exitCode, undefined);
});

test("assertAttachSupported accepts Windows and macOS only", () => {
  assert.doesNotThrow(() => assertAttachSupported("win32"));
  assert.doesNotThrow(() => assertAttachSupported("darwin"));
  assert.throws(() => assertAttachSupported("linux"), /Windows and macOS/);
});

 test("failed Enter skips attachment and preserves acknowledged text", async () => {
  const { calls, deps } = mockDeps({ enterError: Error("Enter refused") });
  const { output, exitCode } = await run(() => sendAndObserve("s1", { command: "send", text: "hello" }, options({ enter: true, attach: true, wait: true, read: true }), launched(), deps));
  assert.deepEqual(calls, ["send", "send"]);
  assert.equal(output().written, true);
  assert.equal(output().enterWritten, undefined);
  assert.equal(output().error.stage, "enter");
  assert.equal(exitCode, 1);
});
