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
  writeFileSync(join(state, "plugins.json"), JSON.stringify({ plugins: ["codex-resume", "claude-code-resume"] }));
  const registry = new Registry(state);
  async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
    for (let i = 0; i < 100; i++) { const value = await read(); if (accept(value)) return value; await sleep(100); }
    throw Error("Expected plugin state/screen not observed");
  }
  for (const kind of ["codex", "claude"]) {
    const child = spawn(process.execPath, [resolve("tests/fixtures/terminal-driver.mjs"), resolve("dist/tide.mjs"), "run", "--shell", shell!, "--", "--noprofile", "--norc", "-i"], {
      cwd: process.cwd(), windowsHide: true,
      env: { ...process.env, TIDE_STATE_DIR: state, TIDE_CODEX_BIN: fake, TIDE_CLAUDE_BIN: fake, CLAUDE_CODE_GIT_BASH_PATH: shell!, TIDE_RESUME_DELAY_SECONDS: "1" },
    });
    let pid = 0, exited = false;
    child.stdout.on("data", (data) => { pid = Number(String(data).trim()); }); child.stderr.resume();
    const exit = new Promise<void>((done) => child.on("exit", () => { exited = true; done(); }));
    let id: string | undefined;
    try {
      const sessions = await until(() => liveSessions(registry), (all) => all.some(({ info }) => info.pid === pid));
      id = sessions.find(({ info }) => info.pid === pid)!.info.id;
      const request = <T = unknown>(command: Parameters<typeof requestSession>[1]) => requestSession<T>(id!, command, registry);
      const plugin = kind === "codex" ? "codex-resume" : "claude-code-resume";
      await request({ command: "send", text: `${quote(posix(process.execPath))} ${quote(posix(resolve("tests/fixtures/quota-cli.mjs")))} ${kind}` });
      await request({ command: "send-key", keys: ["Enter"] });
      await until(() => request<Snapshot>({ command: "capture" }), (screen) => screen.text.includes("RESUME_COUNT=0"));
      await sleep(600);
      const normal = await request<{ phase: string; lastProbe: unknown }>({ command: "plugin", plugin, action: "status", args: [] });
      assert.equal(normal.lastProbe, null, "Old visible limit plus newer completion must not probe");
      await request({ command: "send", text: "/limit" });
      await request({ command: "send-key", keys: ["Enter"] });
      if (kind === "claude") {
        const waiting = await until(async () => {
          try { return await request<{ phase: string; nextProbeAt: number }>({ command: "plugin", plugin, action: "status", args: [] }); }
          catch (error) { if (/does not match/.test(String(error))) return { phase: "redrawing", nextProbeAt: 0 }; throw error; }
        }, (status) => status.phase === "waiting");
        assert(waiting.nextProbeAt > Date.now() + 290000);
        await request({ command: "plugin", plugin, action: "check", args: [] });
      }
      try { await until(() => request<Snapshot>({ command: "capture" }), (screen) => screen.text.includes("RESUME_COUNT=1")); }
      catch {
        throw Error(JSON.stringify({ kind, status: await request({ command: "plugin", plugin, action: "status", args: [] }), screen: await request({ command: "capture" }) }));
      }
      await sleep(600);
      assert((await request<Snapshot>({ command: "capture" })).text.includes("RESUME_COUNT=1"));
      const status = await request<{ lastResumeAt: number; lastError: unknown }>({ command: "plugin", plugin, action: "status", args: [] });
      assert(status.lastResumeAt > 0); assert.equal(status.lastError, null);
      await request({ command: "send", text: "/connection" });
      await request({ command: "send-key", keys: ["Enter"] });
      await until(() => request<Snapshot>({ command: "capture" }), (screen) => screen.text.includes("RESUME_COUNT=2"));
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
  assert.deepEqual(registry.records(), []);
});
