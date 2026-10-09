import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Registry } from '../../src/session/registry.ts';
import { listen } from '../../src/session/ipc.ts';
import type { SessionRecord } from '../../src/session/types.ts';

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
  const child = spawn(process.execPath, [resolve(process.env.TIDE_TEST_ENTRY ?? 'dist/tide.mjs'), 'close', ...args], {
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

test('close --all reports partial failure, clears stale records, and respects registry scope', { timeout: 15000 }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'tc-'));
  const other = mkdtempSync(join(tmpdir(), 'to-'));
  const registry = new Registry(state), outside = new Registry(other);
  const stops: Array<() => void> = [];
  const calls: string[] = [];
  try {
    const good = record(registry), bad = record(registry), stale = record(registry), excluded = record(outside);
    for (const r of [good, bad, excluded]) stops.push(await listen(r, async request => {
      assert.equal(request.command, 'close');
      calls.push(r.id);
      if (r.id === bad.id) throw Error('fixture refused close');
      registry.remove(r.id);
      return { id: r.id, closing: true };
    }));
    for (const args of [['--all', good.id], [good.id, '--all'], ['--all', '--all']]) {
      const invalid = await cli(state, ...args);
      assert.equal(invalid.status, 1);
      assert.equal(invalid.stdout, '');
      assert.match(invalid.stderr, /cannot combine/);
    }
    assert.deepEqual(calls, [], 'invalid options must not close any sessions');
    const result = await cli(state, '--all');
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout) as Array<{ id: string; closing?: boolean; stale?: boolean; error?: { message: string } }>;
    assert.equal(output.length, 3);
    assert.equal(output.find(r => r.id === good.id)?.closing, true);
    assert.equal(output.find(r => r.id === stale.id)?.stale, true);
    assert.match(output.find(r => r.id === bad.id)!.error!.message, /fixture refused close/);
    assert.deepEqual(calls.sort(), [good.id, bad.id].sort());
    assert.deepEqual(registry.records().map(r => r.id), [bad.id], 'unconfirmed failures retain registration');
    assert.equal(outside.records().length, 1);
    registry.remove(bad.id);
    const empty = await cli(state, '--all');
    assert.equal(empty.status, 0, empty.stderr);
    assert.deepEqual(JSON.parse(empty.stdout), []);
  } finally {
    for (const stop of stops) stop();
    rmSync(state, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
