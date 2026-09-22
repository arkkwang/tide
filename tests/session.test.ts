import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Registry } from "../src/terminal/store.ts";
import { liveSessions, requestSession, rpc } from "../src/terminal/ipc.ts";
import type { SessionInfo, Snapshot } from "../src/terminal/types.ts";

const entry = resolve("dist/tide.mjs");
const shell = process.platform === "win32" ? spawnSync("where.exe", ["bash.exe"], { encoding: "utf8", windowsHide: true }).stdout.split(/\r?\n/).find((p) => p && !/WindowsApps/i.test(p)) : "/bin/bash";
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

test("real shell sessions: short IDs, public CLI, plain capture, plugin lifecycle and cleanup", { skip: !shell, timeout: 45000 }, async (t) => {
  mkdirSync(resolve(".tide/tests"), { recursive: true });
  const state = mkdtempSync(resolve(".tide/tests/session-"));
  writeFileSync(join(state, "plugins.json"), JSON.stringify({ plugins: [resolve("examples/screen-plugin.mjs")] }));
  const registry = new Registry(state);
  const children: Array<{ child: ChildProcess; exit: Promise<number>; exited: boolean }> = [];
  async function host() {
    const child = spawn(process.execPath, [resolve('tests/fixtures/terminal-driver.mjs'), entry, "run", "--shell", shell!, "--", "--noprofile", "--norc", "-i"], { windowsHide: true, cwd: process.cwd(), env: { ...process.env, TIDE_STATE_DIR: state, TERM: "xterm-256color" } });
    let hostPid = 0;
    child.stdout.on('data', (data) => { hostPid = Number(String(data).trim()); });
    child.stderr.on('data', (data) => t.diagnostic(String(data)));
    const tracked = { child, exit: Promise.resolve(0), exited: false };
    tracked.exit = new Promise<number>((resolve) => child.on('exit', (code) => { tracked.exited = true; resolve(code ?? 1); }));
    children.push(tracked);
    for (let i = 0; i < 100; i++) {
      const session = (await liveSessions(registry)).find(({ info }) => info.pid === hostPid);
      if (session) return session.info;
      await sleep(100);
    }
    throw Error("Host did not register");
  }
  async function until(id: string, predicate: (s: Snapshot) => boolean) {
    for (let i = 0; i < 80; i++) {
      const snapshot = await requestSession<Snapshot>(id, { command: "capture" }, registry);
      if (predicate(snapshot)) return snapshot;
      await sleep(100);
    }
    throw Error("Expected screen not observed");
  }
  async function cli(args: string[], bash = false, input = "") {
    return new Promise<{ code: number | null; out: string; err: string }>((resolveResult, reject) => {
      const command = `bash ${quote((process.env.TIDE_TEST_SHELL_ENTRY ?? resolve("bin/tide")).replaceAll("\\", "/"))} ${args.map(quote).join(" ")}`;
      const child = spawn(bash ? shell! : process.execPath, bash ? ["--noprofile", "--norc", "-c", command] : [entry, ...args], { windowsHide: true, env: { ...process.env, TIDE_STATE_DIR: state } });
      let out = "", err = "";
      child.stdout.on("data", (data) => { out += data; }); child.stderr.on("data", (data) => { err += data; });
      child.stdin.end(input);
      child.on("error", reject); child.on("exit", (code) => resolveResult({ code, out, err }));
    });
  }
  try {
    const a = await host(), b = await host();
    t.diagnostic('two hosts registered');
    const short = a.id.slice(0, 8);
    await until(short, (s) => s.text.includes("$"));
    assert.equal((await requestSession<SessionInfo>(short, { command: "info" }, registry)).id, a.id);
    const sent = await cli(["send", short, "/help"], true);
    assert.equal(sent.code, 0, sent.err);
    const filled = await until(short, (s) => s.text.includes("/help"));
    assert(!filled.text.includes("Git/help"));
    assert.equal((await cli(["send-key", short, "Ctrl+U"], true)).code, 0);
    const literalHelp = await cli(["send", short, "--help"], true);
    assert.equal(literalHelp.code, 0, literalHelp.err);
    assert.equal(JSON.parse(literalHelp.out).written, true);
    await until(short, (s) => s.text.includes("--help"));
    assert.equal((await cli(["send-key", short, "Ctrl+U"], true)).code, 0);
    await requestSession(short, { command: "send", text: "printf 'FORMAL_%s_OK\\n' SHELL" }, registry);
    assert(!(await requestSession<Snapshot>(short, { command: "capture" }, registry)).text.includes("FORMAL_SHELL_OK"));
    await requestSession(short, { command: "send-key", keys: ["Enter"] }, registry);
    await until(short, (s) => s.text.includes("FORMAL_SHELL_OK"));
    const json = await cli(["capture", short]);
    const plain = await cli(["capture", short, "--plain-text"]);
    assert.equal(json.code, 0); assert.equal(plain.code, 0);
    assert.equal(plain.out, (JSON.parse(json.out) as Snapshot).text + "\n");
    t.diagnostic('send, chord and plain capture passed');
    assert(!plain.out.includes("\x1b"));
    const idle = await cli(['wait-idle', short, '--idle-time', '0.1', '--timeout', '2']);
    assert.equal(idle.code, 0); assert.equal(JSON.parse(idle.out).idle, true);
    const timed = await cli(['wait-idle', short, '--idle-time', '2', '--timeout', '0']);
    assert.equal(timed.code, 3); assert.equal(JSON.parse(timed.out).idle, false);
    // A send remains unsubmitted; Enter then waits for actual shell output.
    const combined = await cli(['send', short, "printf 'COMBINED_%s_OK\\n' SHELL", '--wait-idle', '--idle-time', '0.1', '--timeout', '2', '--with-capture']);
    assert.equal(combined.code, 0, combined.err);
    assert.equal(JSON.parse(combined.out).wait.idle, true);
    assert(!JSON.parse(combined.out).capture.text.includes('COMBINED_SHELL_OK'));
    const submitted = await cli(['send-key', short, 'Enter', '--wait-idle', '--idle-time', '0.2', '--timeout', '3', '--with-capture']);
    assert.equal(submitted.code, 0, submitted.err);
    assert(JSON.parse(submitted.out).capture.text.includes('COMBINED_SHELL_OK'));
    const timeoutCapture = await cli(['send-key', short, 'Ctrl+U', '--wait-idle', '--timeout', '0', '--with-capture']);
    assert.equal(timeoutCapture.code, 3);
    assert.equal(JSON.parse(timeoutCapture.out).wait.idle, false);
    assert.equal(JSON.parse(timeoutCapture.out).capture.id, a.id);
    const immediate = await cli(['send', short, '', '--with-capture']);
    assert.equal(immediate.code, 0);
    assert.equal(JSON.parse(immediate.out).capture.id, a.id);
    assert.equal(JSON.parse(immediate.out).wait, undefined);
    const stdin = await cli(['send', short, '--stdin', '--wait-idle', '--idle-time', '0.1', '--with-capture'], false, '--wait-idle');
    assert.equal(stdin.code, 0, stdin.err);
    assert(JSON.parse(stdin.out).capture.text.includes('--wait-idle'));
    await cli(['send-key', short, 'Ctrl+U']);
    for (const args of [
      ['send', short, 'NEVER_INVALID_INPUT', '--timeout', '1'],
      ['send', short, 'NEVER_INVALID_INPUT', '--wait-idle', '--idle-time', '-1'],
      ['send-key', short, 'Enter', '--with-captur'],
    ]) {
      const invalid = await cli(args);
      assert.equal(invalid.code, 1);
      assert.equal(invalid.out, '');
    }
    assert(!(await requestSession<Snapshot>(short, { command: 'capture' }, registry)).text.includes('NEVER_INVALID_INPUT'));
    const plugins = await cli(["plugins", short]);
    assert.equal(JSON.parse(plugins.out)[0].id, "screen");
    const result = await cli(["plugin", short, "screen", "contains", "FORMAL_SHELL_OK"]);
    assert.equal(JSON.parse(result.out).found, true);
    t.diagnostic('plugin command passed');
    const bad = await cli(["send-key", short, "Enter", "Win+R"]);
    assert.notEqual(bad.code, 0);
    // A colliding registration must block prefix routing before any write.
    const record = registry.records().find((r) => r.id === a.id)!;
    const collision = { ...record, id: `${record.id.slice(0, -1)}${record.id.endsWith("0") ? "1" : "0"}` };
    registry.write(collision);
    await assert.rejects(requestSession(short, { command: "send", text: "never" }, registry), /Ambiguous/);
    registry.remove(collision.id);
    assert.equal((await rpc<SessionInfo>(record, { command: "info" })).id, a.id);
    await assert.rejects(rpc({ ...record, token: "wrong" }, { command: "send", text: "never" }), /Unauthorized/);
    // Observation failure must not hide an acknowledged input write.
    await cli(['send', b.id, 'sleep 0.3; exit']);
    const endedWhileWaiting = await cli(['send-key', b.id, 'Enter', '--wait-idle', '--idle-time', '1', '--timeout', '3', '--with-capture']);
    assert.equal(endedWhileWaiting.code, 1, endedWhileWaiting.out);
    assert.equal(JSON.parse(endedWhileWaiting.out).written, true);
    assert.equal(JSON.parse(endedWhileWaiting.out).error.stage, 'wait-idle');
    assert.match(endedWhileWaiting.err, /Do not resend/);
    await requestSession(a.id.slice(0, 8), { command: "close" }, registry);
    t.diagnostic('close acknowledged');
    for (const { exit } of children) {
      let timer: ReturnType<typeof setTimeout>;
      try { await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Host did not exit after close')), 10000); })]); }
      finally { clearTimeout(timer!); }
    }
    assert.deepEqual(registry.records(), []);
  } finally {
    for (const { child, exited } of children) { try { if (!exited) child.kill(); } catch {} }
  }
});
