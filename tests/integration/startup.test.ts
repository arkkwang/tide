import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { shellCommand } from "../../src/terminal/shell.ts";
import { Registry } from "../../src/session/registry.ts";
import { rpc } from "../../src/session/ipc.ts";

const entry = resolve(process.env.TIDE_TEST_ENTRY ?? "dist/tide.mjs");
const shell = process.env.TIDE_TEST_SHELL ?? shellCommand({}).shell;

test("default state uses the caller's home; sockets and registration are removed on close", { timeout: 20000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "th-"));
  const state = join(home, ".tide"), registry = new Registry(state);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TIDE_STATE_DIR: "", TIDE_SHELL: shell };
  const cli = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], { env, encoding: "utf8", timeout: 10000, windowsHide: true });
  try {
    const launch = cli("launch", "--", "--noprofile", "--norc", "-i");
    assert.equal(launch.status, 0, launch.stderr);
    const id = JSON.parse(launch.stdout).id;
    const record = registry.records().find(record => record.id === id)!;
    assert(record, "registration must be in the caller's home, not next to the build");
    if (process.platform !== "win32") {
      assert(record.endpoint.startsWith(join(state, "sockets") + "/"));
      assert(existsSync(record.endpoint));
      assert(existsSync(record.endpoint + "-display"));
    }
    assert.equal(cli("close", id).status, 0);
    for (let i = 0; i < 100; i++) {
      if (!registry.records().length && (process.platform === "win32" || readdirSync(join(state, "sockets")).length === 0)) break;
      await sleep(50);
    }
    assert.equal(registry.records().length, 0);
    if (process.platform !== "win32") assert.deepEqual(readdirSync(join(state, "sockets")), []);
  } finally {
    for (const record of registry.records()) { try { await rpc(record, { command: "close" }); } catch {} }
    rmSync(home, { recursive: true, force: true });
  }
});

test("unsupported executable and long socket path fail before creating a PTY or registering", { timeout: 20000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "tf-"));
  const cli = (state: string, executable: string) => spawnSync(process.execPath, [entry, "launch", "--shell", executable], {
    env: { ...process.env, TIDE_STATE_DIR: state }, encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  try {
    const unsupported = join(root, "unsupported");
    const result = cli(unsupported, process.execPath);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /Bash >= 4\.4/);
    assert.equal(new Registry(unsupported).records().length, 0);
    assert.equal(existsSync(join(unsupported, "sockets")), false);
    if (process.platform !== "win32") {
      const state = join(root, "x".repeat(100));
      const result = cli(state, shell);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /socket path is too long.*TIDE_STATE_DIR/);
      assert.equal(new Registry(state).records().length, 0);
      assert.equal(existsSync(join(state, "sockets")), false);
    }
    if (process.platform === "darwin") {
      const oldVersion = spawnSync("/bin/bash", ["--version"], { encoding: "utf8" }).stdout;
      if (/version 3\.2\./.test(oldVersion)) {
        const state = join(root, "old");
        const result = cli(state, "/bin/bash");
        assert.equal(result.status, 1);
        assert.match(result.stderr, /requires Bash >= 4\.4.*3\.2/);
        assert.equal(existsSync(join(state, "sockets")), false);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
