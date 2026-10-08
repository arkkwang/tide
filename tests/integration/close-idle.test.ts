import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Registry } from '../../src/session/registry.ts';
import { listen, rpc } from '../../src/session/ipc.ts';
import type { PromptState, Request, SessionInfo, SessionRecord } from '../../src/session/types.ts';

const entry = resolve('dist/tide.mjs');
const shell = process.platform === 'win32' ? spawnSync('where.exe', ['bash.exe'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find((p) => p && !/WindowsApps/i.test(p)) : '/bin/bash';

type Outcome = { id: string; closing?: boolean; stale?: boolean; skipped?: string; idleForMs?: number; error?: { message: string } };

function record(registry: Registry): SessionRecord {
  const id = randomUUID();
  const value: SessionRecord = {
    id, pid: 1, shellPid: 2, shell: 'fixture', cwd: registry.state,
    createdAt: new Date().toISOString(), exited: false, exitCode: null,
    endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\tide-test-${id}` : join(registry.state, `${id}.sock`),
    token: randomUUID(),
  };
  registry.write(value);
  return value;
}

async function cli(state: string, ...args: string[]) {
  const child = spawn(process.execPath, [entry, 'close', ...args], {
    env: { ...process.env, TIDE_STATE_DIR: state }, windowsHide: true,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const status = await new Promise<number | null>((done, reject) => {
    child.on('error', reject); child.on('close', done);
  });
  return { status, stdout, stderr };
}

test('close --idle closes every session waiting at a prompt and reports why others were kept', { timeout: 15000 }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'tide-close-idle-'));
  const empty = mkdtempSync(join(tmpdir(), 'tide-close-idle-empty-'));
  const registry = new Registry(state);
  const stops: Array<() => void> = [];
  try {
    const base = { pid: 1, shellPid: 2, shell: 'bash', cwd: state, createdAt: new Date().toISOString(), exited: false, exitCode: null };
    const waiting = record(registry), running = record(registry), unknown = record(registry);
    const attached = record(registry), refuse = record(registry), gone = record(registry);
    const infos = new Map<string, SessionInfo>([
      [waiting.id, { ...base, id: waiting.id, idleForMs: 0, lastOutputAt: null, lastCommand: null, display: 'detached', promptState: 'at-prompt' }],
      [running.id, { ...base, id: running.id, idleForMs: 90_000, lastOutputAt: null, lastCommand: 'sleep 30', display: 'detached', promptState: 'running' }],
      [unknown.id, { ...base, id: unknown.id, idleForMs: 90_000, lastOutputAt: null, lastCommand: null, display: 'detached', promptState: 'unknown' }],
      [attached.id, { ...base, id: attached.id, idleForMs: 90_000, lastOutputAt: null, lastCommand: null, display: 'attached', promptState: 'at-prompt' }],
      [refuse.id, { ...base, id: refuse.id, idleForMs: 90_000, lastOutputAt: null, lastCommand: null, display: 'detached', promptState: 'at-prompt' }],
    ]);
    const closed: string[] = [];
    for (const r of [waiting, running, unknown, attached, refuse]) stops.push(await listen(r, async (request: Request) => {
      if (request.command === 'info') return infos.get(r.id)!;
      assert.equal(request.command, 'close');
      if (r.id === refuse.id) throw Error('fixture refused close');
      closed.push(r.id);
      registry.remove(r.id);
      return { id: r.id, closing: true };
    }));

    const invalid = [['--all', '--idle'], ['--idle', '--all'], ['--idle', '60'], ['60', '--idle'], ['--idle', waiting.id], [waiting.id, '--idle']];
    for (const args of invalid) {
      const result = await cli(state, ...args);
      assert.equal(result.status, 1, args.join(' '));
      assert.equal(result.stdout, '', args.join(' '));
    }
    assert.match((await cli(state, '--all', '--idle')).stderr, /mutually exclusive/);
    assert.match((await cli(state, '--idle', '60')).stderr, /takes no value/);
    assert.deepEqual(closed, [], 'invalid options must not close any sessions');

    const result = await cli(state, '--idle');
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout) as Outcome[];
    const entryFor = (id: string) => output.find(r => r.id === id)!;
    assert.equal(output.length, 6);
    assert.equal(entryFor(waiting.id).closing, true, 'a silent screen is not required');
    assert.equal(entryFor(running.id).skipped, 'command-running');
    assert.equal(entryFor(unknown.id).skipped, 'prompt-unknown');
    assert.equal(entryFor(attached.id).skipped, 'attached');
    assert.match(entryFor(refuse.id).error!.message, /refused close/);
    assert.equal(entryFor(gone.id).stale, true, 'a missing endpoint is cleared, not closed');
    assert.deepEqual(closed.sort(), [waiting.id]);
    assert.deepEqual(registry.records().map(r => r.id).sort(), [running.id, unknown.id, attached.id, refuse.id].sort(),
      'untouched sessions and unconfirmed failures stay registered');

    registry.remove(refuse.id);
    const repeat = await cli(state, '--idle');
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.deepEqual((JSON.parse(repeat.stdout) as Outcome[]).map(r => r.skipped).sort(),
      ['attached', 'command-running', 'prompt-unknown'], 'nothing left to close is not an error');
    assert.deepEqual(closed.sort(), [waiting.id]);

    const none = await cli(empty, '--idle');
    assert.equal(none.status, 0, none.stderr);
    assert.deepEqual(JSON.parse(none.stdout), []);
  } finally {
    for (const stop of stops) stop();
    rmSync(state, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test('close --idle keeps a real session running a command and closes it once the prompt is back', { skip: !shell, timeout: 60000 }, async () => {  mkdirSync(resolve('.tide/tests'), { recursive: true });
  const state = mkdtempSync(resolve('.tide/tests/close-idle-'));
  const registry = new Registry(state);
  const env = { ...process.env, PS1: '$ ', PROMPT_COMMAND: '', TIDE_STATE_DIR: state, TERM: 'xterm-256color' };
  const run = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', windowsHide: true, timeout: 45000, env });
  const info = (id: string) => JSON.parse(run('info', id).stdout) as SessionInfo;
  async function promptState(id: string, expected: PromptState) {
    for (let i = 0; i < 100; i++) {
      const current = info(id);
      if (current.promptState === expected) return current;
      await sleep(100);
    }
    throw Error(`promptState never became ${expected}: ${JSON.stringify(info(id))}`);
  }
  try {
    const launched = JSON.parse(run('launch', '--shell', shell!, '--cwd', process.cwd(), '--', '--noprofile', '--norc', '-i').stdout) as SessionInfo;
    assert.equal(typeof launched.id, 'string', JSON.stringify(launched));
    assert.equal((await promptState(launched.id, 'at-prompt')).display, 'detached');
    assert.equal(run('send', launched.id, 'sleep 30').status, 0);
    assert.equal(run('send', launched.id, '--key', 'Enter').status, 0);
    await promptState(launched.id, 'running');
    const busy = await cli(state, '--idle');
    assert.equal(busy.status, 0, busy.stderr);
    const kept = JSON.parse(busy.stdout) as Outcome[];
    assert.deepEqual(kept.map(r => [r.id, r.skipped]), [[launched.id, 'command-running']]);
    assert.equal(run('info', launched.id).status, 0, 'a session running a command stays alive');

    assert.equal(run('send', launched.id, '--key', 'Ctrl+C').status, 0);
    await promptState(launched.id, 'at-prompt');
    // Unsubmitted input is deliberately not a reason to keep a session: the
    // caller decides, and a prompt with no command submitted is what --idle means.
    assert.equal(run('send', launched.id, 'git commit -m ').status, 0);
    const closed = await cli(state, '--idle');
    assert.equal(closed.status, 0, closed.stderr);
    assert.deepEqual((JSON.parse(closed.stdout) as Outcome[]).map(r => [r.id, r.closing]), [[launched.id, true]]);
    for (let i = 0; i < 100 && registry.records().length; i++) await sleep(100);
    assert.deepEqual(registry.records(), []);
  } finally {
    for (const record of registry.records()) {
      try { await rpc(record, { command: 'close' }); } catch {}
    }
    rmSync(state, { recursive: true, force: true });
  }
});
