import { explicitCodexResume } from "../src/providers/codex.ts";
import { claudeRecoveryArgs } from "../src/providers/terminal.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { holderRefusal } from "../src/providers/claude/adapter.ts";
import { inspectTranscriptTail } from "../src/providers/claude/history.ts";
import { inputMessage } from "../src/cli/control.ts";
import { executionSnapshot, readTranscript } from "../src/providers/transcript.ts";
import { tailTranscript, waitForTurn, textHash } from "../src/features/conversation.ts";
import { Sessions } from "../src/core/sessions.ts";
function observed(cli: "claude" | "codex") {
  return new Sessions({ kind: cli, resolveBin: () => null, findSessions: async () => [],
    readQuota: async () => { throw new Error("unexpected quota call"); },
    snapshot: (session, limit) => executionSnapshot(cli, session, limit),
    history: (session, after) => readTranscript(cli, session, after) });
}
import { passthroughOnly, stillQuotaLimited, wrapperInvocation } from "../src/features/foreground.ts";
import type { Session } from "../src/core/session.ts";

const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const codexMeta = { type: "session_meta", payload: { id, cwd: process.cwd() } };
const claudeMeta = { type: "user", sessionId: id, cwd: process.cwd(), message: { content: "initial" } };
const codex = (type: string, rest = {}) => ({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type, ...rest } });
const claude = (text: string, type = "assistant") => ({ type, sessionId: id, message: { content: [{ type: "text", text }] } });
const done = { type: "system", sessionId: id, subtype: "turn_duration" };
function fixture(t: any, rows: unknown[]): Session {
  const root = mkdtempSync(join(tmpdir(), "tide-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "deliberately-unrelated-name.jsonl");
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { sessionId: id, cwd: root, transcriptPath: path, isSubagent: false, lastEvent: "running", lastAssistantAt: 1 };
}
function append(session: Session, rows: unknown[]) {
  appendFileSync(session.transcriptPath!, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("Claude tail preserves multiline/Unicode, excludes thinking/tools, pages without loss", (t) => {
  const session = fixture(t, [claudeMeta, claude("中文\n'quoted'"), { type: "assistant", sessionId: id, message: { content: [{ type: "thinking", thinking: "private" }, { type: "tool_use", text: "not a message" }] } }]);
  const initial = tailTranscript(observed("claude"), session, 1);
  assert.equal(initial.messages[0]!.text, "中文\n'quoted'");
  append(session, [claude("one"), claude("two"), claude("three")]);
  const a = tailTranscript(observed("claude"), session, 2, initial.cursor);
  assert.deepEqual(a.messages.map((m) => m.text), ["one", "two"]);
  assert.equal(a.hasMore, true);
  const b = tailTranscript(observed("claude"), session, 2, a.cursor);
  assert.deepEqual(b.messages.map((m) => m.text), ["three"]);
  assert.equal(tailTranscript(observed("claude"), session, 2, b.cursor).messages.length, 0);
});

test("partial final record is not consumed, even across UTF-8 byte splits", (t) => {
  const session = fixture(t, [claudeMeta]);
  const initial = tailTranscript(observed("claude"), session, 10);
  const bytes = Buffer.from(JSON.stringify(claude("中文🙂")) + "\n");
  const split = bytes.indexOf(Buffer.from("🙂")) + 2;
  appendFileSync(session.transcriptPath!, bytes.subarray(0, split));
  const partial = tailTranscript(observed("claude"), session, 10, initial.cursor);
  assert.equal(partial.messages.length, 0);
  appendFileSync(session.transcriptPath!, bytes.subarray(split));
  assert.equal(tailTranscript(observed("claude"), session, 10, partial.cursor).messages[0]!.text, "中文🙂");
});

test("reject invalid, cross-session, replaced and truncated cursors", (t) => {
  const session = fixture(t, [claudeMeta]);
  const cursor = tailTranscript(observed("claude"), session, 1).cursor;
  assert.throws(() => readTranscript("claude", session, "oops"), /Invalid cursor/);
  assert.throws(() => readTranscript("claude", { ...session, sessionId: "other" }, cursor), /different session/);
  writeFileSync(session.transcriptPath!, JSON.stringify({ ...claudeMeta, cwd: "changed" }) + "\n");
  assert.throws(() => readTranscript("claude", session, cursor), /stale/);
  writeFileSync(session.transcriptPath!, "");
  assert.throws(() => readTranscript("claude", session, cursor), /stale/);
});

test("wait ignores old completion, tool use and split end_turn until turn_duration", async (t) => {
  const session = fixture(t, [claudeMeta, claude("old"), done]);
  const cursor = tailTranscript(observed("claude"), session, 1).cursor;
  append(session, [{ type: "assistant", sessionId: id, message: { stop_reason: "tool_use", content: [{ type: "tool_use" }] } },
    { ...claude("answer"), message: { stop_reason: "end_turn", content: [{ type: "text", text: "answer" }] } }]);
  const pending = await waitForTurn(observed("claude"), session, cursor, 0);
  assert.equal(pending.status, "timed-out");
  assert.equal(pending.cursor, cursor);
  append(session, [done]);
  const result = await waitForTurn(observed("claude"), session, pending.cursor, 0);
  assert.equal(result.status, "completed");
  assert.equal(result.text, "answer");
});

test("send baseline waits for its submitted message before accepting any completion", async (t) => {
  const session = fixture(t, [codexMeta, codex("task_started")]);
  const cursor = readTranscript("codex", session).cursor(undefined, textHash("new task"));
  append(session, [codex("task_complete"), codex("task_started"), codex("item_completed", { item: { type: "UserMessage", content: [{ type: "text", text: "new task" }] } }),
    codex("item_completed", { item: { type: "AssistantMessage", content: [{ type: "text", text: "new answer" }] } }), codex("task_complete")]);
  const result = await waitForTurn(observed("codex"), session, cursor, 0);
  assert.equal(result.status, "completed");
  assert.equal(result.text, "new answer");
});

test("Codex terminal errors and aborts remain distinct", async (t) => {
  for (const [row, status] of [
    [codex("task_complete", { error: { codex_error_info: "usage_limit_exceeded" } }), "quota-limited"],
    [codex("task_complete", { error: { codex_error_info: "other" } }), "errored"],
    [codex("turn_aborted"), "aborted"],
  ] as const) {
    const s = fixture(t, [codexMeta]);
    const cursor = readTranscript("codex", s).cursor();
    append(s, [row]);
    const r = await waitForTurn(observed("codex"), s, cursor, 0);
    assert.equal(r.status, status);
    assert.equal(r.ok, false);
  }
});

test("Claude busy, background and unknown holder results fail closed", () => {
  const base = { code: 0, timedOut: false, spawnError: null, out: "[]" };
  assert.equal(holderRefusal(base, id), null);
  for (const row of [{ sessionId: id, pid: 42, status: "idle" }, { sessionId: id, kind: "background", state: "blocked" }]) {
    assert.match(holderRefusal({ ...base, out: JSON.stringify([row]) }, id)!, /held/);
  }
  for (const patch of [{ out: "{}" }, { out: "[{}]" }, { out: "invalid" }, { code: 1 }, { timedOut: true }, { spawnError: "missing" }]) {
    assert.match(holderRefusal({ ...base, ...patch }, id)!, /Cannot confirm/);
  }
});

test("input sources are exclusive, literal and nonempty", (t) => {
  const s = fixture(t, [claudeMeta]);
  const path = join(s.cwd, "message.txt");
  const text = "中文\n'quoted' $() `literal`";
  writeFileSync(path, "\uFEFF" + text);
  assert.equal(inputMessage({ messageFile: path }), text);
  assert.equal(inputMessage({ message: text }), text);
  assert.throws(() => inputMessage({}), /exactly one/);
  assert.throws(() => inputMessage({ message: "a", messageFile: path }), /exactly one/);
  assert.throws(() => inputMessage({ message: "  " }), /empty/);
});

test("Claude state uses metadata ID and does not keep an old quota error after new input", (t) => {
  const s = fixture(t, [claudeMeta, { ...claude("quota"), isApiErrorMessage: true, error: "rate_limit" }]);
  assert.equal(inspectTranscriptTail(s.transcriptPath!)!.status, "quota-limited");
  assert.equal(inspectTranscriptTail(s.transcriptPath!)!.sessionId, id);
  append(s, [claude("next", "user")]);
  assert.equal(inspectTranscriptTail(s.transcriptPath!)!.status, "running");
  append(s, [{ type: "assistant", sessionId: id, message: { stop_reason: "tool_use", content: [{ type: "tool_use" }] } }]);
  assert.equal(inspectTranscriptTail(s.transcriptPath!)!.status, "running");
});

test("Claude status and snapshot agree: assistant text alone is not completion", (t) => {
  const session = fixture(t, [claudeMeta, claude("partial answer")]);
  assert.equal(inspectTranscriptTail(session.transcriptPath!)!.status, "running");
  assert.equal(executionSnapshot("claude", session).lastEvent, "running");
  append(session, [done]);
  assert.equal(inspectTranscriptTail(session.transcriptPath!)!.status, "completed");
  assert.equal(executionSnapshot("claude", session).lastEvent, "completed");
  assert.equal(executionSnapshot("claude", session).currentState, "unknown");
});

test("Claude recovery does not silently relax permissions or replay the first task", () => {
  const args = claudeRecoveryArgs(["--permission-mode", "plan", "original task"], id, "continue");
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  assert.equal(args.includes("original task"), false);
  assert.deepEqual(args, ["--permission-mode", "plan", "--resume", id, "--", "continue"]);
});

test("wrapper forwards CLI-owned flags and classifies read-only commands without watching", () => {
  const args = ["claude", "--model", "custom", "--permission-mode", "plan", "中文\n$'prompt'"];
  assert.deepEqual(wrapperInvocation(args), { cli: "claude", args: args.slice(1) });
  assert.equal(passthroughOnly("claude", ["--version"]), true);
  assert.equal(passthroughOnly("codex", ["exec", "task"]), true);
  assert.equal(explicitCodexResume(["resume", id]), id);
  assert.throws(() => explicitCodexResume(["resume", "--last"]), /explicit UUID/);
  assert.deepEqual(claudeRecoveryArgs(["--model", "m", "--permission-mode", "plan", "initial task"], id, "continue"), ["--model", "m", "--permission-mode", "plan", "--resume", id, "--", "continue"]);
});

test("watch rechecks the interrupted event after quota probe", () => {
  const before: Session = { sessionId: id, cwd: "", isSubagent: false, lastEvent: "quota-limited", lastAssistantAt: 42 };
  assert.equal(stillQuotaLimited(before, { ...before }), true);
  assert.equal(stillQuotaLimited(before, { ...before, lastEvent: "running" }), false);
  assert.equal(stillQuotaLimited(before, { ...before, lastAssistantAt: 43 }), false);
  assert.equal(stillQuotaLimited(before, undefined), false);
});

test("CLI tail and wait do not probe quota or persist invocation flags", (t) => {
  const s = fixture(t, [codexMeta, codex("task_started"), codex("item_completed", { item: { type: "AssistantMessage", content: [{ type: "text", text: "actual output" }] } }), codex("task_complete")]);
  const home = join(s.cwd, "home");
  const state = join(s.cwd, "state");
  // CLI adapter only needs an existing executable for these read-only paths.
  mkdirSync(join(home, "sessions"), { recursive: true });
  mkdirSync(state);
  copyFileSync(s.transcriptPath!, join(home, "sessions", "not-the-session-id.jsonl"));
  const config = '{"dryRun":false,"skipQuotaCheck":false}';
  writeFileSync(join(state, "config.json"), config);
  const env = { ...process.env, CODEX_HOME: home, CODEX_BIN: process.execPath, TIDE_STATE_DIR: state };
  const run = (args: string[]) => spawnSync(process.execPath, ["dist/tide.mjs", ...args], { env, encoding: "utf8", timeout: 8000, windowsHide: true });
  const tail = run(["tail", id, "--cli", "codex", "--json"]);
  assert.equal(tail.status, 0, tail.stderr + tail.stdout);
  const parsed = JSON.parse(tail.stdout);
  assert.equal(parsed.messages[0].text, "actual output");
  const waited = run(["wait", id, "--cli", "codex", "--after", parsed.cursor, "--timeout", "0", "--json"]);
  assert.equal(waited.status, 3, waited.stderr + waited.stdout);
  assert.equal(JSON.parse(waited.stdout).status, "timed-out");
  const dry = run(["send", id, "--cli", "codex", "--message", "task", "--dry-run", "--json"]);
  assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  assert.equal(JSON.parse(dry.stdout).delivered, false);
  const interrupted = run(["send", id, "--cli", "codex", "--message", "correction", "--mode", "interrupt", "--json"]);
  assert.equal(interrupted.status, 1, interrupted.stderr);
  assert.equal(JSON.parse(interrupted.stdout).unsupported, true);
  const status = run(["status", "--cli", "codex", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).clis[0].sessions[0].currentState, "unknown");
  const snapshot = run(["snapshot", id, "--cli", "codex", "--json"]);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.equal(JSON.parse(snapshot.stdout).lastEvent, "completed");
  const quota = run(["quota", "--cli", "codex", "--dry-run", "--json"]);
  assert.equal(quota.status, 0, quota.stderr);
  assert.equal(JSON.parse(quota.stdout).dryRun, true);
  const plainSnapshot = run(["snapshot", id, "--cli", "codex"]);
  assert.equal(plainSnapshot.status, 0, plainSnapshot.stderr);
  assert.match(plainSnapshot.stdout, /Last recorded event: completed/);
  assert.match(plainSnapshot.stdout, /actual output/);
  for (const args of [
    ["deny-current", "--dry-run"],
    ["resume", id, "extra"],
    ["unwatch", id, "--cli", "codex", "--dry-run"],
    ["unwatch", id.slice(0, 8), "--cli", "codex"],
    ["watch", "--session", id, "--session-all"],
    ["status", "--message", "ignored"],
    ["quota", "--cli", "typo"],
  ]) {
    const rejected = run([...args, "--json"]);
    assert.equal(rejected.status, 2, rejected.stdout + rejected.stderr);
    assert.equal(JSON.parse(rejected.stdout).ok, false);
    const plainRejected = run(args);
    assert.equal(plainRejected.status, 2, plainRejected.stdout + plainRejected.stderr);
    assert.match(plainRejected.stderr, /not supported|exactly one|cannot be combined|must be/);
  }
  assert.equal(readFileSync(join(state, "config.json"), "utf8"), config);
});

test("wait observes a future append and never modifies the transcript", async (t) => {
  const session = fixture(t, [claudeMeta]);
  const cursor = readTranscript("claude", session).cursor();
  const timer = setTimeout(() => append(session, [claude("later"), done]), 20);
  t.after(() => clearTimeout(timer));
  const result = await waitForTurn(observed("claude"), session, cursor, 2);
  assert.equal(result.status, "completed");
  assert.equal(result.text, "later");
  const before = readFileSync(session.transcriptPath!);
  const timedOut = await waitForTurn(observed("claude"), session, result.cursor, 0.01);
  assert.equal(timedOut.status, "timed-out");
  assert.deepEqual(readFileSync(session.transcriptPath!), before);
});

test("tail clears a send-specific message expectation for subsequent general waits", async (t) => {
  const session = fixture(t, [claudeMeta]);
  const sent = readTranscript("claude", session).cursor(undefined, textHash("first task"));
  append(session, [claude("first task", "user"), claude("first answer"), done]);
  const tailed = tailTranscript(observed("claude"), session, 10, sent);
  append(session, [claude("second task", "user"), claude("second answer"), done]);
  const result = await waitForTurn(observed("claude"), session, tailed.cursor, 0);
  assert.equal(result.status, "completed");
  assert.equal(result.text, "second answer");
});
