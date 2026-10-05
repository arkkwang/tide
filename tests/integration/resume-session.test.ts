import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Registry } from "../../src/session/registry.ts";
import { liveSessions, requestSession } from "../../src/session/ipc.ts";
import type { Snapshot } from "../../src/session/types.ts";

const shell = process.platform === "win32" ? spawnSync("where.exe", ["bash.exe"], { encoding: "utf8", windowsHide: true }).stdout.split(/\r?\n/).find((p) => p && !/WindowsApps/i.test(p)) : "/bin/bash";
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const posix = (path: string) => path.replaceAll("\\", "/");

test("both bundled plugins recover only interrupted tasks through real Tide sessions and CLI probes", { skip: !shell, timeout: 40000 }, async () => {
  mkdirSync(resolve(".tide/tests"), { recursive: true });
  const state = mkdtempSync(resolve(".tide/tests/resume-"));
  const fake = join(state, "quota-cli");
  writeFileSync(fake, `#!/usr/bin/env bash\nexec ${quote(posix(process.execPath))} ${quote(posix(resolve("tests/fixtures/quota-cli.mjs")))} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(state, "plugins.json"), JSON.stringify({ plugins: ["cxr", "ccr"] }));
  const registry = new Registry(state);
  async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
    for (let i = 0; i < 100; i++) { const value = await read(); if (accept(value)) return value; await sleep(100); }
    throw Error("Expected plugin state/screen not observed");
  }
  for (const kind of ["codex", "claude"]) {
    const child = spawn(process.execPath, [resolve("tests/fixtures/terminal-driver.mjs"), resolve("dist/tide.mjs"), "run", "--shell", shell!, "--", "--noprofile", "--norc", "-i"], {
      cwd: process.cwd(), windowsHide: true,
      // Claude's probe throttle must exceed the cooldown for `waiting` to be observable.
      env: { ...process.env, TIDE_STATE_DIR: state, TIDE_CODEX_BIN: fake, TIDE_CLAUDE_BIN: fake, CLAUDE_CODE_GIT_BASH_PATH: shell!, TIDE_RESUME_DELAY_SECONDS: "1", TIDE_INITIAL_DELAY_SECONDS: "3" },
    });
    let pid = 0, exited = false;
    child.stdout.on("data", (data) => { pid = Number(String(data).trim()); }); child.stderr.resume();
    const exit = new Promise<void>((done) => child.on("exit", () => { exited = true; done(); }));
    let id: string | undefined;
    try {
      const sessions = await until(() => liveSessions(registry), (all) => all.some(({ info }) => info.pid === pid));
      id = sessions.find(({ info }) => info.pid === pid)!.info.id;
      const request = <T = unknown>(command: Parameters<typeof requestSession>[1]) => requestSession<T>(id!, command, registry);
      const plugin = kind === "codex" ? "cxr" : "ccr";
      await request({ command: "send", text: `${quote(posix(process.execPath))} ${quote(posix(resolve("tests/fixtures/quota-cli.mjs")))} ${kind}` });
      await request({ command: "send", keys: ["Enter"] });
      await until(() => request<Snapshot>({ command: "read" }), (screen) => screen.text.includes("RESUME_COUNT=0"));
      // Bundled plugins do not auto-watch; flip the monitor on after the CLI is up.
      await request({ command: "plugin", plugin, action: "watch", args: [] });
      await sleep(600);
      const normal = await request<{ monitor: { lastProbe: unknown } }>({ command: "plugin", plugin, action: "status", args: [] });
      assert.equal(normal.monitor.lastProbe, null, "Old visible limit plus newer completion must not probe");
      await request({ command: "send", text: "/limit" });
      await request({ command: "send", keys: ["Enter"] });
      if (kind === "claude") {
        const waiting = await until(async () => {
          try { return await request<{ monitor: { phase: string; nextProbeAt: number | null; lastResumeAt: number | null } }>({ command: "plugin", plugin, action: "status", args: [] }); }
          catch (error) { if (/does not match/.test(String(error))) return { monitor: { phase: "redrawing", nextProbeAt: null, lastResumeAt: null } }; throw error; }
        }, (status) => status.monitor.phase === "waiting");
        assert(waiting.monitor.lastResumeAt === null);
        assert(waiting.monitor.nextProbeAt !== null);
      }
      try { await until(() => request<Snapshot>({ command: "read" }), (screen) => screen.text.includes("RESUME_COUNT=1")); }
      catch {
        throw Error(JSON.stringify({ kind, status: await request({ command: "plugin", plugin, action: "status", args: [] }), screen: await request({ command: "read" }) }));
      }
      await sleep(600);
      assert((await request<Snapshot>({ command: "read" })).text.includes("RESUME_COUNT=1"));
      const status = await request<{ monitor: { lastResumeAt: number; lastError: unknown } }>({ command: "plugin", plugin, action: "status", args: [] });
      assert(status.monitor.lastResumeAt > 0); assert.equal(status.monitor.lastError, null);
      await request({ command: "send", text: "/connection" });
      await request({ command: "send", keys: ["Enter"] });
      await until(() => request<Snapshot>({ command: "read" }), (screen) => screen.text.includes("RESUME_COUNT=2"));
      await request({ command: "close" });
      await until(async () => exited, Boolean);
      await exit;
    } finally {
      if (!exited) {
        if (id) await requestSession(id, { command: "close" }, registry).catch(() => {});
        await until(async () => exited, Boolean).catch(() => child.kill());
      }
    }
  }
  // Viewer exit can precede the host's registry cleanup; close only acknowledges
  // the request. Wait for the actual lifecycle result rather than racing it.
  await until(async () => registry.records(), (records) => records.length === 0);
  assert.deepEqual(registry.records(), []);
});
