import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Registry } from "../../src/session/registry.ts";
import { liveSessions, requestSession, rpc } from "../../src/session/ipc.ts";
import type { SessionInfo, Snapshot, Request } from "../../src/session/types.ts";

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
      const snapshot = await requestSession<Snapshot>(id, { command: "read" }, registry);
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
    const initialInfo = await requestSession<SessionInfo>(short, { command: "info" }, registry);
    assert.equal(initialInfo.id, a.id);
    assert.equal(initialInfo.lastCommand, null);
    const sent = await cli(["send", short, "/help"], true);
    assert.equal(sent.code, 0, sent.err);
    const filled = await until(short, (s) => s.text.includes("/help"));
    assert(!filled.text.includes("Git/help"));
    assert.equal((await requestSession<SessionInfo>(short, { command: "info" }, registry)).lastCommand, null, 'unsubmitted input is not a command');
    // Plugin arguments are literal text too: `tide <plugin-id> <command> ...` is a
    // namespace, and bin/tide must keep MSYS from rewriting them the same way.
    const pluginLiteral = await cli(['screen', 'contains', short, '/help'], true);
    assert.equal(pluginLiteral.code, 0, pluginLiteral.err);
    assert.equal(JSON.parse(pluginLiteral.out).found, true, pluginLiteral.out);
    assert.equal((await cli(["send", short, "--key", "Ctrl+U"], true)).code, 0);
    const literalHelp = await cli(["send", short, "--help"], true);
    assert.equal(literalHelp.code, 0, literalHelp.err);
    assert.equal(JSON.parse(literalHelp.out).written, true);
    await until(short, (s) => s.text.includes("--help"));
    assert.equal((await cli(["send", short, "--key", "Ctrl+U"], true)).code, 0);
    await requestSession(short, { command: "send", text: "printf 'FORMAL_%s_OK\\n' SHELL" }, registry);
    assert(!(await requestSession<Snapshot>(short, { command: "read" }, registry)).text.includes("FORMAL_SHELL_OK"));
    await requestSession(short, { command: "send", keys: ["Enter"] }, registry);
    await until(short, (s) => s.text.includes("FORMAL_SHELL_OK"));
    await cli(['wait-idle', short, '--idle-time', '0.2', '--timeout', '3']);
    const activity = JSON.parse((await cli(['info', short])).out) as SessionInfo;
    assert(typeof activity.idleForMs === 'number' && activity.idleForMs >= 150);
    assert(Number.isFinite(Date.parse(activity.lastOutputAt!)));
    const listed = JSON.parse((await cli(['list'])).out) as SessionInfo[];
    const listedActivity = listed.find((s) => s.id === a.id)!;
    assert(listedActivity.idleForMs! >= activity.idleForMs);
    assert.equal(listedActivity.lastOutputAt, activity.lastOutputAt);
    assert.equal(activity.lastCommand, "printf 'FORMAL_%s_OK\\n' SHELL");
    assert.equal(listedActivity.lastCommand, activity.lastCommand);
    const json = await cli(["read", short]);
    const plain = await cli(["read", short, "--plain-text"]);
    assert.equal(json.code, 0); assert.equal(plain.code, 0);
    const dimensions = JSON.parse(json.out) as Snapshot;
    const sameSize = await cli(['resize', short, '--cols', String(dimensions.cols), '--rows', String(dimensions.rows), '--with-read']);
    assert.equal(sameSize.code, 0, sameSize.err);
    assert.equal(JSON.parse(sameSize.out).applied, true);
    assert.equal(JSON.parse(sameSize.out).read.cols, dimensions.cols);
    const unsupportedScroll = await cli(['scroll', short, 'up']);
    assert.equal(unsupportedScroll.code, 1);
    assert.match(unsupportedScroll.err, /SGR/);
    assert.equal(plain.out, (JSON.parse(json.out) as Snapshot).text + "\n");
    t.diagnostic('send, chord and plain capture passed');
    assert(!plain.out.includes("\x1b"));
    const idle = await cli(['wait-idle', short, '--idle-time', '0.1', '--timeout', '2']);
    assert.equal(idle.code, 0, idle.err + idle.out); assert.equal(JSON.parse(idle.out).idle, true);
    const timed = await cli(['wait-idle', short, '--idle-time', '2', '--timeout', '0']);
    assert.equal(timed.code, 3, timed.err + timed.out); assert.equal(JSON.parse(timed.out).idle, false);
    for (const timeout of ['2', '0']) {
      const captured = await cli(['wait-idle', short, '--with-read', '--idle-time', '0.1', '--timeout', timeout]);
      assert.equal(captured.code, timeout === '0' ? 3 : 0, captured.err);
      const result = JSON.parse(captured.out);
      assert.equal(result.idle, timeout !== '0');
      assert.equal(result.id, a.id);
      assert.equal(result.read.id, a.id);
      assert(result.read.text.includes('FORMAL_SHELL_OK'));
      assert.equal(typeof result.elapsedMs, 'number');
    }
    // A send remains unsubmitted; Enter then waits for actual shell output.
    const combined = await cli(['send', short, "printf 'COMBINED_%s_OK\\n' SHELL", '--wait-idle', '--idle-time', '0.1', '--timeout', '2', '--with-read']);
    assert.equal(combined.code, 0, combined.err);
    assert.equal(JSON.parse(combined.out).wait.idle, true);
    assert(!JSON.parse(combined.out).read.text.includes('COMBINED_SHELL_OK'));
    const submitted = await cli(['send', short, '--key', 'Enter', '--wait-idle', '--timeout', '6', '--with-read']);
    assert.equal(submitted.code, 0, submitted.err);
    assert(JSON.parse(submitted.out).read.text.includes('COMBINED_SHELL_OK'), submitted.out);
    assert(!JSON.parse(submitted.out).read.text.includes('FORMAL_SHELL_OK'), submitted.out);

    const history = await cli(['read', short, '--full']);
    assert(!JSON.parse(history.out).text.includes('FORMAL_SHELL_OK'), history.out);
    assert(JSON.parse(history.out).text.includes('COMBINED_SHELL_OK'), history.out);
    for (const piped of [false, true]) {
      const text = `printf 'ENTER_%s_OK\\n' ${piped ? 'STDIN' : 'TEXT'}`;
      const result = await cli(['send', short, piped ? '--stdin' : text, '--with-enter', '--wait-idle', '--timeout', '6', '--with-read'], false, piped ? text : '');
      assert.equal(result.code, 0, result.err);
      assert.equal(JSON.parse(result.out).enterWritten, true);
      assert(JSON.parse(result.out).read.text.includes(`ENTER_${piped ? 'STDIN' : 'TEXT'}_OK`));
    }
    const timeoutCapture = await cli(['send', short, '--key', 'Ctrl+U', '--wait-idle', '--timeout', '0', '--with-read']);
    assert.equal(timeoutCapture.code, 3);
    assert.equal(JSON.parse(timeoutCapture.out).wait.idle, false);
    assert.equal(JSON.parse(timeoutCapture.out).read.id, a.id);
    const immediate = await cli(['send', short, '', '--with-read']);
    assert.equal(immediate.code, 0);
    assert.equal(JSON.parse(immediate.out).read.id, a.id);
    assert.equal(JSON.parse(immediate.out).wait, undefined);
    for (const args of [
      ['send', short, '', '--lines', '5', '--with-read'],
      ['send', short, '--key', 'Ctrl+U', '--with-read', '--lines', '5'],
      ['resize', short, '--cols', String(dimensions.cols), '--lines', '5', '--rows', String(dimensions.rows), '--with-read'],
      ['wait-idle', short, '--lines', '5', '--timeout', '0', '--with-read'],
    ]) {
      const result = await cli(args);
      assert.equal(result.code, args[0] === 'wait-idle' ? 3 : 0, result.err);
      assert(JSON.parse(result.out).read.text.split('\n').filter((line: string) => !line.startsWith('[Earlier ')).length <= 5);
    }
    const [full, cropped, other] = await Promise.all([
      cli(['read', short]), cli(['read', short, '--lines', '5']), cli(['read', b.id]),
    ]);
    assert.equal(JSON.parse(full.out).id, a.id);
    assert.equal(JSON.parse(cropped.out).id, a.id);
    assert.equal(JSON.parse(other.out).id, b.id);
    assert(JSON.parse(cropped.out).text.split('\n').filter((line: string) => !line.startsWith('[Earlier ')).length <= 5);
    assert.deepEqual(JSON.parse((await cli(['read', short])).out).text, JSON.parse(full.out).text);
    const stdin = await cli(['send', short, '--stdin', '--wait-idle', '--idle-time', '0.1', '--with-read'], false, '--wait-idle');
    assert.equal(stdin.code, 0, stdin.err);
    assert(JSON.parse(stdin.out).read.text.includes('--wait-idle'));
    await cli(['send', short, '--key', 'Ctrl+U']);
    for (const args of [
      ['wait-idle', short, '--with-read', '--timeout', '-1'],
      ['wait-idle', short, '--with-captur'],
      ['wait-idle', short, '--lines', '5'],
      ['send', short, 'NEVER_INVALID_INPUT', '--with-enter', '--lines', '5'],
      ['send', short, 'NEVER_INVALID_INPUT', '--with-read', '--lines', '0'],
      ['send', short, '--key', 'Enter', '--with-read', '--lines', '2001'],
      ['scroll', short, 'up', '--with-read', '--lines', '1.5'],
      ['resize', short, '--cols', '100', '--rows', '30', '--lines', '5'],
      ['send', short, 'NEVER_INVALID_INPUT', '--timeout', '1'],
      ['send', short, 'NEVER_INVALID_INPUT', '--wait-idle', '--idle-time', '-1'],
      ['send', short, '--key', 'Enter', '--with-captur'],
      ['send', short, '--key', 'Enter', '--with-enter'],
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
    assert(!(await requestSession<Snapshot>(short, { command: 'read' }, registry)).text.includes('NEVER_INVALID_INPUT'));
    const plugins = await cli(["plugin", "status", short]);
    assert.equal(JSON.parse(plugins.out)[0].id, "screen");
    const direct = await cli(["screen", "contains", short, "FORMAL_SHELL_OK"]);
    const single = JSON.parse(direct.out) as { id: string; found: boolean };
    assert.equal(single.found, true, direct.err + direct.out);
    // `--all` replaces the session ID: one entry per matching session, and each
    // session answers for itself exactly as when addressed directly.
    const all = await cli(["screen", "contains", "--all", "FORMAL_SHELL_OK"]);
    assert.equal(all.code, 0, all.err + all.out);
    const entries = JSON.parse(all.out) as Array<{ id: string; result?: { id: string; found: boolean }; error?: string }>;
    assert.deepEqual(entries.map((e) => e.id).sort(), [a.id, b.id].sort());
    const byId = new Map(entries.map((e) => [e.id, e]));
    assert.deepEqual([byId.get(a.id)?.error, byId.get(b.id)?.error], [undefined, undefined], all.out);
    assert.equal(byId.get(a.id)!.result!.id, single.id);
    assert.equal(byId.get(a.id)!.result!.found, single.found);
    assert.equal(byId.get(b.id)!.result!.found, false, all.out);
    // The plugin's own help marks which commands accept --all.
    assert.match((await cli(["screen", "--help"])).out, /^  contains\* /m);
    t.diagnostic('plugin command passed');
    // Raw input proves literal text, ordered keys and zero partial writes on errors.
    const probe = `${quote(process.execPath.replaceAll("\\", "/"))} ${quote(resolve("tests/fixtures/input-probe.mjs").replaceAll("\\", "/"))}`;
    const startedProbe = await cli(['send', short, probe, '--with-enter']);
    assert.equal(startedProbe.code, 0, startedProbe.err);
    await until(short, (s) => s.text.includes('INPUT_PROBE_READY'));
    for (const args of [
      ['send-key', short, 'Enter'], // No historical alias.
      ['send', short, 'NEVER_MIXED_TEXT', '--key', 'Enter'],
      ['send', short, '--stdin', '--key', 'Enter'],
      ['send', short, '--key', 'Enter', '--stdin'],
      ['send', short, '--key', 'Enter', '--with-enter'],
      ['send', short, '--key', 'Enter', 'Win+R'],
      ['send', short, '--key', 'Ctrl+U', 'hello', 'Enter'],
      ['send', short, '--key', 'Enter', '--key', 'Up'],
      ['send', short, '--key', ...Array(65).fill('Enter')],
    ]) {
      const rejected = await cli(args, false, 'NEVER_STDIN_TEXT');
      assert.equal(rejected.code, 1, rejected.err);
      assert.equal(rejected.out, '');
    }
    for (const request of [
      { command: 'send', text: 'NEVER_RPC_TEXT', keys: ['Enter'] },
      { command: 'send' },
      { command: 'send', keys: 'Enter' },
      { command: 'send', keys: [] },
      { command: 'send', keys: Array(65).fill('Enter') },
      { command: 'send', keys: ['Enter', 'Win+R'] },
      { command: 'send', keys: ['Enter', 1] },
    ]) await assert.rejects(requestSession(short, request as Request, registry));
    for (const text of ['Enter', 'Ctrl+C', 'q']) {
      const literal = await cli(['send', short, text]);
      assert.equal(literal.code, 0, literal.err);
    }
    for (const text of ['--key', '--stdin']) {
      const literal = await cli(['send', short, '--stdin'], false, text);
      assert.equal(literal.code, 0, literal.err);
    }
    const beforeEnter = await requestSession<Snapshot>(short, { command: 'read' }, registry);
    assert(!beforeEnter.text.includes('INPUT_PROBE_BYTES:'));
    const sequence = await cli(['send', short, '--key', 'Up', 'Enter']);
    assert.equal(sequence.code, 0, sequence.err);
    const received = await until(short, (s) => s.text.includes('INPUT_PROBE_BYTES:'));
    const expectedBytes = Buffer.from('EnterCtrl+Cq--key--stdin\x1b[A\r').toString('hex');
    assert.equal(received.text.match(/INPUT_PROBE_BYTES:([0-9a-f]+)/)?.[1], expectedBytes);
    // A colliding registration must block prefix routing before any write.
    const record = registry.records().find((r) => r.id === a.id)!;
    const collision = { ...record, id: `${record.id.slice(0, -1)}${record.id.endsWith("0") ? "1" : "0"}` };
    registry.write(collision);
    await assert.rejects(requestSession(short, { command: "send", text: "never" }, registry), /Ambiguous/);
    registry.remove(collision.id);
    assert.equal((await rpc<SessionInfo>(record, { command: "info" })).id, a.id);
    await assert.rejects(rpc({ ...record, token: "wrong" }, { command: "send", text: "never" }), /Unauthorized/);
    // Public reads trim unused rows without changing the terminal or JSON shape.
    const trimmed = await cli(['send', b.id, "printf '\\033[2J\\033[HREAD_TRIM\\n'", '--with-enter', '--wait-idle', '--idle-time', '0.2', '--timeout', '3', '--with-read']);
    assert.equal(trimmed.code, 0, trimmed.err);
    const view = JSON.parse(trimmed.out).read as Snapshot;
    assert.match(view.text, /READ_TRIM/);
    assert(view.text.split('\n').length < view.rows, 'unused viewport rows are omitted');
    assert(view.text.split('\n').at(-1)!.trim().length > 0, 'the shell prompt, not blank padding, is the tail');
    for (const options of [[], ['--full']]) {
      const read = await cli(['read', b.id, ...options]);
      assert.equal(read.code, 0, read.err);
      const snapshot = JSON.parse(read.out) as Snapshot;
      assert.equal(snapshot.text, view.text);
      assert.deepEqual(snapshot.cursor, view.cursor);
      assert.equal(snapshot.rows, view.rows);
      const plain = await cli(['read', b.id, ...options, '--plain-text']);
      assert.equal(plain.code, 0, plain.err);
      assert.equal(plain.out, snapshot.text + '\n');
    }
    const limited = await cli(['read', b.id, '--lines', '1']);
    assert.equal(limited.code, 0, limited.err);
    assert.equal(JSON.parse(limited.out).text.split('\n').at(-1), view.text.split('\n').at(-1));
    // Combined and standalone public reads share the head/tail preview.
    const longOutput = await cli(['send', b.id, "printf 'READ_PREVIEW_%s\\n' {0..79}", '--with-enter', '--wait-idle', '--idle-time', '0.2', '--timeout', '3', '--with-read']);
    assert.equal(longOutput.code, 0, longOutput.err);
    const preview = JSON.parse(longOutput.out).read as Snapshot;
    const previewRows = preview.text.split('\n');
    assert.equal(previewRows.length, 41);
    assert.equal(previewRows[10], '[... middle output omitted ...]');

    assert.match(preview.text, /READ_PREVIEW_0\n/);
    assert.match(preview.text, /READ_PREVIEW_79/);
    assert.equal(JSON.parse((await cli(['read', b.id])).out).text, preview.text);
    assert.equal((await cli(['read', b.id, '--plain-text'])).out, preview.text + '\n');
    const complete = JSON.parse((await cli(['read', b.id, '--full'])).out) as Snapshot;
    assert.match(complete.text, /READ_PREVIEW_40/);
    assert.doesNotMatch(complete.text, /output omitted/);
    const nextFull = await cli(['send', b.id, "printf 'LATEST_%s\\n' DONE", '--with-enter', '--wait-idle', '--idle-time', '0.2', '--timeout', '3', '--with-read', '--full']);
    assert.equal(nextFull.code, 0, nextFull.err);
    assert.equal(JSON.parse(nextFull.out).read.text, JSON.parse((await cli(['read', b.id, '--full'])).out).text);
    assert.doesNotMatch(JSON.parse(nextFull.out).read.text, /READ_PREVIEW/);
    // Observation failure must not hide an acknowledged input write.
    await cli(['send', b.id, 'sleep 0.3; exit 7']);
    // ConPTY may report shell exit after the final screen has already gone quiet.
    const endedWhileWaiting = await cli(['send', b.id, '--key', 'Enter', '--wait-idle', '--idle-time', '10', '--timeout', '15', '--with-read']);
    assert.equal(endedWhileWaiting.code, 1, endedWhileWaiting.out);
    assert.equal(JSON.parse(endedWhileWaiting.out).written, true);
    // Host shutdown can race with either observation request.
    assert(['wait-idle', 'read'].includes(JSON.parse(endedWhileWaiting.out).error.stage));
    assert.match(endedWhileWaiting.err, /Do not resend/);
    // A size-changing resize is exercised last. Under ConPTY, MSYS bash was once seen
    // (outside tide, not reproducible on demand) to drop the first byte of the write
    // that follows one, so nothing here sends input after this point; the cost is that
    // "input immediately after a size change" is not covered.
    // ConPTY may handle XTWINOPS itself; other outer terminals may ignore it.
    const ignoredResize = await cli(['resize', short, '--cols', '110', '--rows', '32', '--with-read']);
    assert([0, 3].includes(ignoredResize.code!), ignoredResize.err);
    const resized = JSON.parse(ignoredResize.out);
    assert.equal(resized.applied, resized.actual.cols === 110 && resized.actual.rows === 32);
    assert.equal(resized.actual.cols, resized.read.cols);
    assert.equal(resized.actual.rows, resized.read.rows);
    await requestSession(a.id.slice(0, 8), { command: "close" }, registry);
    t.diagnostic('close acknowledged');
    const codes: number[] = [];
    for (const { exit } of children) {
      let timer: ReturnType<typeof setTimeout>;
      // A healthy host needs ~6.5s: node-pty's console-list helper fails and leaves a
      // 5s ref'd timer behind, and main.ts lets the loop drain rather than forcing an
      // exit. This budget only needs to catch a real hang.
      try { codes.push(await Promise.race([exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Host did not exit after close')), 15000); })])); }
      finally { clearTimeout(timer!); }
    }
    // `b`'s shell exited 7 on its own; `a` was closed while its shell was still alive.
    assert.deepEqual(codes.sort((x, y) => x - y), [0, 7], 'host exit code must follow the hosted shell');
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
    const result = cli("launch", "--shell", shell!, "--cwd", process.cwd(), "--with-command", "printf 'LAUNCH_%s_OK\\n' COMBINED", "--wait-idle", "--idle-time", "0.3", "--timeout", "5", "--with-read", "--", "--noprofile", "--norc", "-i");
    assert.equal(result.status, 0, result.stderr);
    const launched = JSON.parse(result.stdout);
    assert.equal(launched.written, true);
    assert.equal(launched.enterWritten, true);
    assert.equal(launched.wait.idle, true);
    assert.equal(launched.read.id, launched.id);
    assert.equal(typeof launched.shellPid, "number");
    assert.equal(JSON.parse(cli("info", launched.id).stdout).lastCommand, "printf 'LAUNCH_%s_OK\\n' COMBINED");
    assert.match(launched.read.text, /LAUNCH_COMBINED_OK/);
    assert.ok(launched.read.text.includes(`T${launched.id.slice(0, 8)}`), `prompt marker missing: ${launched.read.text}`);
    assert.doesNotMatch(launched.read.text, /__git_ps1: command not found/);
    const timed = cli("launch", "--with-command", "printf 'TIMEOUT_%s_OK\\n' LAUNCH", "--shell", shell!, "--wait-idle", "--timeout", "0", "--with-read", "--lines", "5", "--", "--noprofile", "--norc", "-i");
    assert.equal(timed.status, 3, timed.stderr);
    const timeout = JSON.parse(timed.stdout);
    assert.equal(timeout.written, true);
    assert.equal(timeout.enterWritten, true);
    assert.equal(timeout.wait.idle, false);
    assert.equal(timeout.read.id, timeout.id);
    assert(timeout.read.text.split("\n").filter((line: string) => !line.startsWith('[Earlier ')).length <= 5);
    assert.equal(cli("info", timeout.id).status, 0);
  } finally {
    for (const record of registry.records()) {
      try { await rpc(record, { command: "close" }); } catch {}
    }
  }
});
