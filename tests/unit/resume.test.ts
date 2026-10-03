import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectScreen } from "../../src/plugins/recovery/screen.ts";
import { claudeAvailability } from "../../src/plugins/claude-code-resume/index.ts";
import { codexAvailability, codexPongAvailability } from "../../src/plugins/codex-resume/index.ts";
import { ResumeMonitor, resumePlugin, PROBE_INTERVAL_MS, RESUME_DELAY_MS, type Availability, type Probe, type StatusReport } from "../../src/plugins/recovery/monitor.ts";
import { Plugins, type PluginContext } from "../../src/plugins/runtime.ts";
import type { Snapshot } from "../../src/session/types.ts";

// Pin TIDE_STATE_DIR to an empty temp dir so tests don't pick up the user's
// resume-patterns.json (intentional user override). Lazy init in screen.ts
// observes whatever env is set when inspectScreen first runs.
process.env.TIDE_STATE_DIR = mkdtempSync(join(tmpdir(), "tide-test-resume-"));

function screen(body = "● You've hit your limit · resets 8pm", input = "", kind = "claude"): Snapshot {
  const text = `${kind === "claude" ? "Claude Code" : "OpenAI Codex"}\n${body}\n\n${kind === "claude" ? "❯" : "›"} ${input}\n  ${kind === "claude" ? "bypass permissions on · shift+tab to cycle" : "90% context left · ? for shortcuts"}`;
  return { id: "session", capturedAt: "now", cols: 100, rows: 30, buffer: "normal", title: "", text };
}

test("resume detection uses the latest response and current composer, not old quota text", () => {
  for (const kind of ["claude", "codex"] as const) {
    assert(inspectScreen(kind, screen(undefined, "", kind)).interruption);
    const trimmed = screen(undefined, "", kind);
    trimmed.text = trimmed.text.split("\n").map((line) => line.trimEnd()).join("\n");
    assert(inspectScreen(kind, trimmed).interruption, "rendered snapshots trim the empty composer's trailing space");
    for (const body of ["● Done", "● You've hit your limit\n● Task completed successfully", "● The log says: You've hit your limit", "● API Error: 500"]) {
      assert.equal(inspectScreen(kind, screen(body, "", kind)).interruption, null, body);
    }
    // Recovery message without a ● marker leaves the previous quota line as
    // the latest ●-marked response — by design (no chaining heuristics).
    assert.equal(inspectScreen(kind, screen("● You've hit your limit\nEverything is working now", "", kind)).interruption?.kind, "quota");
    assert.equal(inspectScreen(kind, screen(undefined, "user is typing", kind)).interruption, null);
    const shell = screen(undefined, "", kind); shell.text += "\nuser@host $ ";
    assert.equal(inspectScreen(kind, shell).matched, false);
    const busy = screen(undefined, "", kind); busy.text += "\nesc to interrupt";
    assert.equal(inspectScreen(kind, busy).matched, true);
    assert.equal(inspectScreen(kind, busy).ready, false);
    assert.equal(inspectScreen(kind, busy).interruption, null);
  }
});

test("quota parsers require affirmative recovery evidence", () => {
  assert.equal(codexPongAvailability(0, "pong\n").allowed, true);
  for (const [code, message] of [[1, "pong"], [0, ""], [0, "Connection failed"], [0, "logs contain pong"]] as const) {
    assert.equal(codexPongAvailability(code, message).allowed, null);
  }
  assert.equal(codexAvailability({ ordinaryUsageAllowed: true }).allowed, true);
  assert.equal(codexAvailability({ ordinaryUsageAllowed: false }).allowed, false);
  assert.equal(codexAvailability({ ordinaryUsageAllowed: null, rateLimits: { primary: { usedPercent: 0, resetsAt: 0 } } }).allowed, null);
  const success = { type: "result", subtype: "success", is_error: false, result: "pong" };
  assert.equal(claudeAvailability(success, 0).allowed, true);
  assert.equal(claudeAvailability({ ...success, is_error: true, result: "Not logged in" }, 1).allowed, null);
  assert.equal(claudeAvailability({ ...success, result: "API Error: 429", api_error_status: 429 }, 1).allowed, false);
  assert.equal(claudeAvailability({ ...success, result: "Something else" }, 0).allowed, null);
});

test("watch and unwatch flip the plugin between watching and disabled; the plugin probes only after a real interruption", async () => {
  let probes = 0;
  const probe: Probe = async () => { probes++; return { allowed: true, reason: "ok" }; };
  const f = fixture(probe);
  const busy = screen(); busy.text += " · esc to interrupt · 29 agents";
  f.setScreen(busy);
  const plugins = new Plugins([resumePlugin("ccr", "Claude Code recovery", "claude", probe)], f.context);
  await plugins.start();
  try {
    const observed = async () => (await plugins.run("ccr", "status", []) as StatusReport).monitor;
    assert.equal((await observed()).enabled, false, "plugin starts disabled (no auto-watch)");
    assert.equal((await observed()).phase, "disabled");
    await plugins.run("ccr", "watch", []);
    assert.equal((await observed()).enabled, true);
    assert.equal((await observed()).phase, "watching");
    // No quota on the busy screen ⇒ the enabled monitor still does not probe.
    await f.monitor.tick(true);
    assert.equal(probes, 0);
    assert.deepEqual(f.writes, []);
    await plugins.run("ccr", "unwatch", []);
    assert.equal((await observed()).enabled, false);
    assert.equal((await observed()).phase, "disabled");
  } finally { await plugins.dispose(); await f.monitor.dispose(); }
});

function fixture(probe: Probe, delay = PROBE_INTERVAL_MS, quietMs = 0) {
  let current = screen(), now = 1000;
  const writes: string[] = [];
  const context: PluginContext = {
    session: { id: "session", pid: 1, shellPid: 2, shell: "bash", cwd: ".", createdAt: "now", exited: false, exitCode: null },
    capture: async () => current,
    send: async (text) => { writes.push(text); current = screen(undefined, text); },
    sendKey: async (...keys) => { writes.push(...keys); },
    onOutput: () => () => {},
  };
  const monitor = new ResumeMonitor(context, "claude", probe, delay, () => now, quietMs);
  return { monitor, context, writes, setScreen: (value: Snapshot) => { current = value; }, advance: (ms = PROBE_INTERVAL_MS) => { now += ms; }, now: () => now };
}

type Fixture = ReturnType<typeof fixture>;
// Tests read monitor state through the public status() report rather than
// reaching into the monitor's fields.
const phaseOf = async (f: Fixture) => (await f.monitor.status()).monitor.phase;
const interruptionOf = async (f: Fixture) => (await f.monitor.status()).monitor.interruption;
async function resumeAfter(f: Fixture): Promise<number | null> {
  const { decision } = await f.monitor.status();
  return decision.kind === "wait" ? f.now() + decision.remainingMs : null;
}

test("connection errors are classified separately; active retries and auth errors are excluded", () => {
  for (const kind of ["codex", "claude"] as const) {
    assert.equal(inspectScreen(kind, screen("■ exceeded retry limit, last status: 429 Too Many Requests", "", kind)).interruption?.kind, "quota");
    for (const message of ["API Error: Connection error.", "API Error: Request timed out.", "stream disconnected before completion: network error", "exceeded retry limit, last status: 503 Service Unavailable"]) {
      assert.equal(inspectScreen(kind, screen(`■ ${message}`, "", kind)).interruption?.kind, "connection");
    }
    for (const message of ["API Error: Connection error. Retrying in 3 seconds", "Reconnecting... 2/5", "API Error: 401 Unauthorized", "exceeded retry limit, last status: 403 Forbidden", "The log says: Connection error.", "API Error: Connection error.\n● Completed successfully"]) {
      assert.equal(inspectScreen(kind, screen(`■ ${message}`, "", kind)).interruption, null, message);
    }
  }
});

test("both interruption types require three stable minutes, including manual check", async () => {
  for (const body of ["● You've hit your limit", "● API Error: Connection error."]) {
    let calls = 0;
    const f = fixture(async () => { calls++; return { allowed: true, reason: "ok" }; }, 0, RESUME_DELAY_MS);
    try {
      f.setScreen(screen(body));
      await f.monitor.tick(true);
      assert.equal(await phaseOf(f), "cooldown");
      f.advance(RESUME_DELAY_MS - 1); await f.monitor.tick(true);
      assert.equal(calls, 0); assert.equal(f.writes.length, 0);
      f.advance(1); await f.monitor.tick(false);
      assert.equal(calls, 1); assert.equal(f.writes.at(-1), "Enter");
      assert(f.writes[0]!.includes(body.includes("Connection") ? "连接中断" : "限额中断"));
    } finally { await f.monitor.dispose(); }
  }
});

test("render changes reset cooldown, identical redraws do not; retries cancel the episode", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { allowed: true, reason: "ok" }; }, 0, RESUME_DELAY_MS);
  try {
    await f.monitor.tick(false); const first = await resumeAfter(f);
    f.advance(60000); await f.monitor.tick(false); assert.equal(await resumeAfter(f), first);
    const resized = screen(); resized.cols = 80; f.setScreen(resized);
    await f.monitor.tick(false); assert.equal(await resumeAfter(f), first! + 60000);
    f.advance(120000); await f.monitor.tick(true); assert.equal(calls, 0);
    f.setScreen(screen("● API Error: Connection error. Retrying in 4 seconds"));
    await f.monitor.tick(false); assert.equal(await interruptionOf(f), null);
    f.setScreen(screen("● API Error: Connection error.")); await f.monitor.tick(false);
    f.advance(RESUME_DELAY_MS); await f.monitor.tick(false); assert.equal(calls, 1);
  } finally { await f.monitor.dispose(); }
});

test("screen changes during a probe must complete a new cooldown before resuming", async () => {
  let finish!: (value: Availability) => void;
  const f = fixture(() => new Promise((resolve) => { finish = resolve; }), 0, RESUME_DELAY_MS);
  try {
    await f.monitor.tick(false); f.advance(RESUME_DELAY_MS);
    const pending = f.monitor.tick(false); await new Promise((resolve) => setImmediate(resolve));
    const changed = screen(); changed.cols = 90; f.setScreen(changed);
    finish({ allowed: true, reason: "ok" }); await pending;
    assert.deepEqual(f.writes, []);
    await f.monitor.tick(true); assert.equal(await phaseOf(f), "cooldown");
  } finally { await f.monitor.dispose(); }
});

test("Claude waits five minutes, rechecks blocked probes, then sends once via core input", async () => {
  let probes = 0;
  const f = fixture(async () => ({ allowed: ++probes > 1, reason: "fixture" }));
  try {
    await f.monitor.tick(false); assert.equal(probes, 0);
    f.advance(); await f.monitor.tick(false); assert.equal(probes, 1); assert.deepEqual(f.writes, []);
    await f.monitor.tick(false); assert.equal(probes, 1);
    f.advance(); await f.monitor.tick(false); assert.equal(probes, 2);
    assert.deepEqual(f.writes, ["继续完成刚才因限额中断的任务。", "Enter"]);
    f.setScreen(screen()); await f.monitor.tick(true);
    assert.equal(probes, 2); assert.equal(f.writes.length, 2);
  } finally { await f.monitor.dispose(); }
});

test("normal completion and stale quota screens never trigger a probe or continuation", async () => {
  const f = fixture(async () => { throw Error("must not probe"); });
  try {
    f.setScreen(screen("● You've hit your limit\n● Done"));
    await f.monitor.tick(true); assert.deepEqual(f.writes, []);
    assert.equal(await interruptionOf(f), null);
  } finally { await f.monitor.dispose(); }
});

test("a newer response while a probe runs cancels recovery even if quota becomes available", async () => {
  let finish!: (value: Availability) => void;
  const f = fixture(() => new Promise((resolve) => { finish = resolve; }));
  try {
    const pending = f.monitor.tick(true);
    await new Promise((resolve) => setImmediate(resolve));
    f.setScreen(screen("● You've hit your limit\n● Done"));
    await f.monitor.tick(false); finish({ allowed: true, reason: "recovered" }); await pending;
    assert.deepEqual(f.writes, []);
  } finally { await f.monitor.dispose(); }
});

test("changed input or failed submission is not retried automatically", async () => {
  for (const changed of [false, true]) {
    const f = fixture(async () => ({ allowed: true, reason: "recovered" }));
    f.context.sendKey = async () => { throw Error("uncertain delivery"); };
    if (changed) f.context.send = async (text) => { f.writes.push(text); f.setScreen(screen(undefined, "human input")); };
    try {
      await f.monitor.tick(true);
      assert.equal(await phaseOf(f), "delivery-unknown");
      f.setScreen(screen()); await f.monitor.tick(true);
      assert.equal(f.writes.length, 1);
    } finally { await f.monitor.dispose(); }
  }
});

test("setEnabled(false) cancels a pending probe; separate monitors do not share interruptions", async () => {
  let finish!: (value: Availability) => void;
  const a = fixture(() => new Promise((resolve) => { finish = resolve; }));
  const b = fixture(async () => ({ allowed: true, reason: "recovered" }));
  try {
    const pending = a.monitor.tick(true); await new Promise((resolve) => setImmediate(resolve));
    a.monitor.setEnabled(false); finish({ allowed: true, reason: "recovered" }); await pending;
    await b.monitor.tick(true);
    assert.deepEqual(a.writes, []); assert.equal(b.writes.length, 2);
  } finally { await a.monitor.dispose(); await b.monitor.dispose(); }
});
