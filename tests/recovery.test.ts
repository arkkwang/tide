import { Sessions } from "../src/core/sessions.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Recovery } from "../src/features/recovery.ts";
import { stopMonitor } from "../src/features/monitor.ts";
import type { Config } from "../src/config.ts";
import type { Adapter, Session } from "../src/core/session.ts";

function scenario(t: any) {
  const stateDir = mkdtempSync(join(tmpdir(), "tide-recovery-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const config = { stateDir, dryRun: false, skipQuotaCheck: false, sessionDenyList: [],
    watchPolicy: { idleMinutesBeforeResume: 0, sweepIntervalMinutes: 0, skipSubagents: true }, resume: { prompt: "continue" } } as unknown as Config;
  const session: Session = { sessionId: "recovery-test", cwd: stateDir, lastEvent: "quota-limited", lastAssistantAt: 1, isSubagent: false };
  let sent = 0;
  const adapter: Adapter = { history: () => { throw new Error("unused"); }, snapshot: () => { throw new Error("unused"); }, kind: "codex", resolveBin: () => null, findSessions: async () => [{ ...session }],
    readQuota: async () => ({ allowed: true, blockedReason: null, primary: null, secondary: null, nextResetAt: null, plan: null, notes: [] }),
    send: async () => { sent++; return { ok: true, delivered: true, via: "test", detail: "queued" }; } };
  return { config, session, adapter, system: new Sessions(adapter), sent: () => sent };
}

test("new user input during quota check cancels the old recovery", async (t) => {
  const x = scenario(t);
  const quota = x.adapter.readQuota;
  x.adapter.readQuota = async () => { x.session.lastEvent = "running"; return quota(); };
  const before = { ...x.session };
  assert.match(await new Recovery(x.config).attempt(x.system, before, () => false), /changed/);
  assert.equal(x.sent(), 0);
});

test("cancelling monitoring during the quota probe prevents delivery", async (t) => {
  const x = scenario(t);
  let stopped = false;
  const quota = x.adapter.readQuota;
  x.adapter.readQuota = async () => { stopped = true; return quota(); };
  await new Recovery(x.config).attempt(x.system, x.session, () => stopped);
  assert.equal(x.sent(), 0);
});

test("two monitor instances cannot deliver the same interruption twice", async (t) => {
  const x = scenario(t);
  await Promise.all([new Recovery(x.config).attempt(x.system, x.session, () => false), new Recovery(x.config).attempt(x.system, x.session, () => false)]);
  await new Recovery(x.config).attempt(x.system, x.session, () => false);
  assert.equal(x.sent(), 1);
});

test("lost acknowledgement survives watcher restart and does not invite a retry", async (t) => {
  const x = scenario(t);
  let attempts = 0;
  x.adapter.send = async () => { attempts++; throw new Error("lost receipt"); };
  await new Recovery(x.config).attempt(x.system, x.session, () => false);
  const detail = await new Recovery(x.config).attempt(x.system, x.session, () => false);
  assert.match(detail, /unknown/);
  assert.equal(attempts, 1);
});

test("known busy rejection can be retried; it is not marked delivered", async (t) => {
  const x = scenario(t);
  let attempts = 0;
  x.adapter.send = async () => { attempts++; return { ok: false, delivered: false, deferred: true, via: "test", detail: "occupied" }; };
  await new Recovery(x.config).attempt(x.system, x.session, () => false);
  await new Promise((r) => setTimeout(r, 1010));
  await new Recovery(x.config).attempt(x.system, x.session, () => false);
  assert.equal(attempts, 2);
});

test("dry run does not probe or persist recovery state", async (t) => {
  const x = scenario(t);
  x.adapter.readQuota = async () => { throw new Error("must not probe"); };
  const config = { ...x.config, dryRun: true } as Config;
  assert.match(await new Recovery(config).attempt(x.system, x.session, () => false), /dry run/);
  assert.equal(existsSync(join(config.stateDir, "recovery")), false);
  assert.equal(x.sent(), 0);
});

test("unwatch excludes a session even from an independently running all-session watcher", async (t) => {
  const x = scenario(t);
  stopMonitor(x.config, "codex", x.session.sessionId);
  x.adapter.readQuota = async () => { throw new Error("Cancelled target must not probe"); };
  assert.equal(await new Recovery(x.config).attempt(x.system, x.session, () => false), "Not eligible");
  assert.equal(x.sent(), 0);
});

test("quota-check cooldown is shared across monitor instances", async (t) => {
  const x = scenario(t);
  let probes = 0;
  const readQuota = x.adapter.readQuota;
  x.adapter.readQuota = async () => { probes++; return { ...await readQuota(), allowed: false }; };
  await new Recovery(x.config).attempt(x.system, x.session, () => false);
  assert.match(await new Recovery(x.config).attempt(x.system, x.session, () => false), /next quota/);
  assert.equal(probes, 1);
});
