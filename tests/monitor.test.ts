import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../src/config.ts";
import { monitorState, stopMonitor } from "../src/features/monitor.ts";

async function until(predicate: () => boolean, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for monitor transition");
    await new Promise((r) => setTimeout(r, 50));
  }
}
test("detached monitor takes over when its foreground owner exits, and unwatch stops only monitoring", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tide-monitor-"));
  const config = { stateDir: dir } as Config;
  const parent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  const worker = spawn(process.execPath, ["dist/tide.mjs", "__monitor", "codex", "test-session", String(parent.pid)], {
    detached: true, windowsHide: true, stdio: "ignore", env: { ...process.env, TIDE_STATE_DIR: dir, CODEX_HOME: join(dir, "empty-home"), CODEX_BIN: process.execPath },
  });
  t.after(async () => {
    parent.kill();
    stopMonitor(config, "codex", "test-session");
    try { await until(() => worker.exitCode !== null); } finally {
      if (worker.exitCode === null) worker.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  await until(() => monitorState(config, "codex", "test-session").phase === "standby");
  parent.kill();
  await until(() => monitorState(config, "codex", "test-session").phase === "watching");
  assert.equal(worker.exitCode, null);
  stopMonitor(config, "codex", "test-session");
  await until(() => worker.exitCode !== null);
  assert.equal(worker.exitCode, 0);
  assert.equal(monitorState(config, "codex", "test-session").phase, "stopped");
});

test("watch immediately after unwatch waits for the cancelled owner before enabling a new worker", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tide-rewatch-"));
  const config = { stateDir: dir } as Config;
  const lock = join(dir, "monitors", "codex-__all__.lock");
  const env = { ...process.env, TIDE_STATE_DIR: dir, CODEX_HOME: join(dir, "empty-home"), CODEX_BIN: process.execPath };
  t.after(async () => {
    stopMonitor(config, "codex", "__all__");
    await until(() => !existsSync(lock));
    rmSync(dir, { recursive: true, force: true });
  });
  const watch = () => spawnSync(process.execPath, ["dist/tide.mjs", "watch", "--cli", "codex", "--session-all"], { env, windowsHide: true, encoding: "utf8", timeout: 10000 });
  const first = watch();
  assert.equal(first.status, 0, first.stderr);
  stopMonitor(config, "codex", "__all__");
  const second = watch();
  assert.equal(second.status, 0, second.stderr);
  const state = monitorState(config, "codex", "__all__");
  assert.equal(state.enabled, true);
  assert.ok(state.phase === "standby" || state.phase === "watching");
});
