import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Registry } from "../../src/session/registry.ts";
import { liveSessions, requestSession, rpc } from "../../src/session/ipc.ts";
import type { SessionInfo, Snapshot } from "../../src/session/types.ts";

const entry = resolve("dist/tide.mjs");
const shell = process.platform === "win32" ? spawnSync("where.exe", ["bash.exe"], { encoding: "utf8", windowsHide: true }).stdout.split(/\r?\n/).find((p) => p && !/WindowsApps/i.test(p)) : "/bin/bash";
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
// These tests skip Bash startup files, so inherited prompts may reference unloaded functions.
const testEnv = { ...process.env, PS1: "$ ", PROMPT_COMMAND: "" };

test("real shell sessions: short IDs, public CLI, plain capture, plugin lifecycle and cleanup", { skip: !shell, timeout: 60000 }, async (t) => {
  mkdirSync(resolve(".tide/tests"), { recursive: true });
  const state = mkdtempSync(resolve(".tide/tests/session-"));
  writeFileSync(join(state, "plugins.json"), JSON.stringify({ plugins: [resolve("examples/screen-plugin.mjs")] }));
  const registry = new Registry(state);
  const children: Array<{ child: ChildProcess; exit: Promise<number>; exited: boolean }> = [];
  async function host() {
    const child = spawn(process.execPath, [resolve('tests/fixtures/terminal-driver.mjs'), entry, "run", "--shell", shell!, "--", "--noprofile", "--norc", "-i"], { windowsHide: true, cwd: process.cwd(), env: { ...testEnv, TIDE_STATE_DIR: state, TERM: "xterm-256color" } });
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
      const child = spawn(bash ? shell! : process.execPath, bash ? ["--noprofile", "--norc", "-c", command] : [entry, ...args], { windowsHide: true, env: { ...testEnv, TIDE_STATE_DIR: state } });
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
    await cli(['wait-idle', short, '--idle-time', '0.2', '--timeout', '3']);
    const activity = JSON.parse((await cli(['info', short])).out) as SessionInfo;
    assert(typeof activity.idleForMs === 'number' && activity.idleForMs >= 150);
    assert(Number.isFinite(Date.parse(activity.lastOutputAt!)));
    const listed = JSON.parse((await cli(['list'])).out) as SessionInfo[];
    const listedActivity = listed.find((s) => s.id === a.id)!;
    assert(listedActivity.idleForMs! >= activity.idleForMs);
    assert.equal(listedActivity.lastOutputAt, activity.lastOutputAt);
    const json = await cli(["capture", short]);
    const plain = await cli(["capture", short, "--plain-text"]);
    assert.equal(json.code, 0); assert.equal(plain.code, 0);
    const dimensions = JSON.parse(json.out) as Snapshot;
    const sameSize = await cli(['resize', short, '--cols', String(dimensions.cols), '--rows', String(dimensions.rows), '--with-capture']);
    assert.equal(sameSize.code, 0, sameSize.err);
    assert.equal(JSON.parse(sameSize.out).applied, true);
    assert.equal(JSON.parse(sameSize.out).capture.cols, dimensions.cols);
    const unsupportedScroll = await cli(['scroll', short, 'up']);
    assert.equal(unsupportedScroll.code, 1);
    assert.match(unsupportedScroll.err, /SGR/);
    // ConPTY may handle XTWINOPS itself; other outer terminals may ignore it.
    const ignoredResize = await cli(['resize', short, '--cols', '110', '--rows', '32', '--with-capture']);
    assert([0, 3].includes(ignoredResize.code!), ignoredResize.err);
    const resized = JSON.parse(ignoredResize.out);
    assert.equal(resized.applied, resized.actual.cols === 110 && resized.actual.rows === 32);
    assert.equal(resized.actual.cols, resized.capture.cols);
    assert.equal(resized.actual.rows, resized.capture.rows);
    const restored = await cli(['resize', short, '--cols', String(dimensions.cols), '--rows', String(dimensions.rows)]);
    assert.equal(restored.code, 0, restored.err);
    assert.equal(plain.out, (JSON.parse(json.out) as Snapshot).text + "\n");
    t.diagnostic('send, chord and plain capture passed');
    assert(!plain.out.includes("\x1b"));
    const idle = await cli(['wait-idle', short, '--idle-time', '0.1', '--timeout', '2']);
    assert.equal(idle.code, 0); assert.equal(JSON.parse(idle.out).idle, true);
    const timed = await cli(['wait-idle', short, '--idle-time', '2', '--timeout', '0']);
    assert.equal(timed.code, 3); assert.equal(JSON.parse(timed.out).idle, false);
    for (const timeout of ['2', '0']) {
      const captured = await cli(['wait-idle', short, '--with-capture', '--idle-time', '0.1', '--timeout', timeout]);
      assert.equal(captured.code, timeout === '0' ? 3 : 0, captured.err);
      const result = JSON.parse(captured.out);
      assert.equal(result.idle, timeout !== '0');
      assert.equal(result.id, a.id);
      assert.equal(result.capture.id, a.id);
      assert(result.capture.text.includes('FORMAL_SHELL_OK'));
      assert.equal(typeof result.elapsedMs, 'number');
    }
    // A send remains unsubmitted; Enter then waits for actual shell output.
    const combined = await cli(['send', short, "printf 'COMBINED_%s_OK\\n' SHELL", '--wait-idle', '--idle-time', '0.1', '--timeout', '2', '--with-capture']);
    assert.equal(combined.code, 0, combined.err);
    assert.equal(JSON.parse(combined.out).wait.idle, true);
    assert(!JSON.parse(combined.out).capture.text.includes('COMBINED_SHELL_OK'));
    const submitted = await cli(['send-key', short, 'Enter', '--wait-idle', '--timeout', '6', '--with-capture']);
    assert.equal(submitted.code, 0, submitted.err);
    assert(JSON.parse(submitted.out).capture.text.includes('COMBINED_SHELL_OK'), submitted.out);
    for (const piped of [false, true]) {
      const text = `printf 'ENTER_%s_OK\\n' ${piped ? 'STDIN' : 'TEXT'}`;
      const result = await cli(['send', short, piped ? '--stdin' : text, '--with-enter', '--wait-idle', '--timeout', '6', '--with-capture'], false, piped ? text : '');
      assert.equal(result.code, 0, result.err);
      assert.equal(JSON.parse(result.out).enterWritten, true);
      assert(JSON.parse(result.out).capture.text.includes(`ENTER_${piped ? 'STDIN' : 'TEXT'}_OK`));
    }
    const timeoutCapture = await cli(['send-key', short, 'Ctrl+U', '--wait-idle', '--timeout', '0', '--with-capture']);
    assert.equal(timeoutCapture.code, 3);
    assert.equal(JSON.parse(timeoutCapture.out).wait.idle, false);
    assert.equal(JSON.parse(timeoutCapture.out).capture.id, a.id);
    const immediate = await cli(['send', short, '', '--with-capture']);
    assert.equal(immediate.code, 0);
    assert.equal(JSON.parse(immediate.out).capture.id, a.id);
    assert.equal(JSON.parse(immediate.out).wait, undefined);
    for (const args of [
      ['send', short, '', '--lines', '5', '--with-capture'],
      ['send-key', short, 'Ctrl+U', '--with-capture', '--lines', '5'],
      ['resize', short, '--cols', String(dimensions.cols), '--lines', '5', '--rows', String(dimensions.rows), '--with-capture'],
      ['wait-idle', short, '--lines', '5', '--timeout', '0', '--with-capture'],
    ]) {
      const result = await cli(args);
      assert.equal(result.code, args[0] === 'wait-idle' ? 3 : 0, result.err);
      assert.equal(JSON.parse(result.out).capture.text.split('\n').length, 5);
    }
    const [full, cropped, other] = await Promise.all([
      cli(['capture', short]), cli(['capture', short, '--lines', '5']), cli(['capture', b.id]),
    ]);
    assert.equal(JSON.parse(full.out).id, a.id);
    assert.equal(JSON.parse(cropped.out).id, a.id);
    assert.equal(JSON.parse(other.out).id, b.id);
    assert.equal(JSON.parse(cropped.out).text.split('\n').length, 5);
    assert.deepEqual(JSON.parse((await cli(['capture', short])).out).text, JSON.parse(full.out).text);
    const stdin = await cli(['send', short, '--stdin', '--wait-idle', '--idle-time', '0.1', '--with-capture'], false, '--wait-idle');
    assert.equal(stdin.code, 0, stdin.err);
    assert(JSON.parse(stdin.out).capture.text.includes('--wait-idle'));
    await cli(['send-key', short, 'Ctrl+U']);
    for (const args of [
      ['wait-idle', short, '--with-capture', '--timeout', '-1'],
      ['wait-idle', short, '--with-captur'],
      ['wait-idle', short, '--lines', '5'],
      ['send', short, 'NEVER_INVALID_INPUT', '--with-enter', '--lines', '5'],
      ['send', short, 'NEVER_INVALID_INPUT', '--with-capture', '--lines', '0'],
      ['send-key', short, 'Enter', '--with-capture', '--lines', '2001'],
      ['scroll', short, 'up', '--with-capture', '--lines', '1.5'],
      ['resize', short, '--cols', '100', '--rows', '30', '--lines', '5'],
      ['send', short, 'NEVER_INVALID_INPUT', '--timeout', '1'],
      ['send', short, 'NEVER_INVALID_INPUT', '--wait-idle', '--idle-time', '-1'],
      ['send-key', short, 'Enter', '--with-captur'],
      ['send-key', short, 'Enter', '--with-enter'],
      ['send', short, 'NEVER_INVALID_INPUT', '--with-enter', '--bad-option'],
      ['scroll', short, 'left'],
      ['scroll', short, 'up', '--steps', '0'],
      ['resize', short, '--cols', '100'],
      ['resize', short, '--cols', '100', '--rows', '30', '--with-enter'],
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
    // ConPTY may report shell exit after the final screen has already gone quiet.
    const endedWhileWaiting = await cli(['send-key', b.id, 'Enter', '--wait-idle', '--idle-time', '10', '--timeout', '15', '--with-capture']);
    assert.equal(endedWhileWaiting.code, 1, endedWhileWaiting.out);
    assert.equal(JSON.parse(endedWhileWaiting.out).written, true);
    // Host shutdown can race with either observation request.
    assert(['wait-idle', 'capture'].includes(JSON.parse(endedWhileWaiting.out).error.stage));
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

test("launch submits a command and returns its rendered output in one call", { skip: !shell || !["win32", "darwin"].includes(process.platform), timeout: 60000 }, async () => {
  mkdirSync(resolve(".tide/tests"), { recursive: true });
  const state = mkdtempSync(resolve(".tide/tests/launch-"));
  const registry = new Registry(state);
  const cli = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8", windowsHide: true, timeout: 45000, env: { ...testEnv, TIDE_STATE_DIR: state },
  });
  try {
    const result = cli("launch", "--shell", shell!, "--cwd", process.cwd(), "--with-command", "printf 'LAUNCH_%s_OK\\n' COMBINED", "--wait-idle", "--idle-time", "0.3", "--timeout", "5", "--with-capture", "--", "--noprofile", "--norc", "-i");
    assert.equal(result.status, 0, result.stderr);
    const launched = JSON.parse(result.stdout);
    assert.equal(launched.written, true);
    assert.equal(launched.enterWritten, true);
    assert.equal(launched.wait.idle, true);
    assert.equal(launched.capture.id, launched.id);
    assert.equal(typeof launched.shellPid, "number");
    assert.match(launched.capture.text, /LAUNCH_COMBINED_OK/);
    assert.doesNotMatch(launched.capture.text, /__git_ps1: command not found/);
    const timed = cli("launch", "--with-command", "printf 'TIMEOUT_%s_OK\\n' LAUNCH", "--shell", shell!, "--wait-idle", "--timeout", "0", "--with-capture", "--lines", "5", "--", "--noprofile", "--norc", "-i");
    assert.equal(timed.status, 3, timed.stderr);
    const timeout = JSON.parse(timed.stdout);
    assert.equal(timeout.written, true);
    assert.equal(timeout.enterWritten, true);
    assert.equal(timeout.wait.idle, false);
    assert.equal(timeout.capture.id, timeout.id);
    assert.equal(timeout.capture.text.split("\n").length, 5);
    assert.equal(cli("info", timeout.id).status, 0);
  } finally {
    for (const record of registry.records()) {
      try { await rpc(record, { command: "close" }); } catch {}
    }
  }
});
