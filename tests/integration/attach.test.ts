import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { createConnection } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import pty from 'node-pty';
import { Registry } from '../../src/session/registry.ts';
import { rpc } from '../../src/session/ipc.ts';
import { displayEndpoint, type DisplayEvent } from '../../src/session/display.ts';
import { Screen } from '../../src/terminal/screen.ts';
import type { SessionInfo, SessionRecord, Snapshot } from '../../src/session/types.ts';

const entry = resolve('dist/tide.mjs');
const until = async <T>(get: () => Promise<T>, check: (value: T) => boolean) => {
  for (let i = 0; i < 100; i++) { const value = await get(); if (check(value)) return value; await sleep(50); }
  throw Error('Expected session state was not observed');
};

// Uses ConPTY / a Unix PTY as the viewer's outer terminal; never launches WT/open.
test('background host and viewer share one PTY; disconnect and reattach preserve the application', { timeout: 40000 }, async () => {
  mkdirSync(resolve('.tide/tests'), { recursive: true });
  const state = mkdtempSync(resolve('.tide/tests/attach-'));
  const registry = new Registry(state);
  const viewers: pty.IPty[] = [], sockets: ReturnType<typeof createConnection>[] = [], screens: Screen[] = [];
  let record: SessionRecord | undefined;
  const info = () => rpc<SessionInfo>(record!, { command: 'info' });
  const read = () => rpc<Snapshot>(record!, { command: 'read', full: true });
  try {
    const launched = spawnSync(process.execPath, [entry, 'launch', '--shell', process.execPath, '--', resolve('tests/fixtures/attach-app.mjs')], {
      env: { ...process.env, TIDE_STATE_DIR: state }, encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    assert.equal(launched.status, 0, launched.stderr);
    const session = JSON.parse(launched.stdout) as SessionInfo;
    record = registry.records().find(r => r.id === session.id)!;
    assert(record); assert.equal(session.display, 'detached');
    await until(read, s => s.text.includes('ATTACH_APP'));
    await rpc(record, { command: 'send', text: 'query' });
    await until(read, s => s.text.includes('REPORTS:1'));
    await sleep(200);
    assert.doesNotMatch((await read()).text, /REPORTS:2/);
    const originalPid = session.shellPid;
    const resized = await rpc<{ applied: boolean }>(record, { command: 'resize', cols: 90, rows: 25 });
    assert.equal(resized.applied, true);
    const reservation = await rpc<{ ticket: string }>(record, { command: 'attach-reserve' });
    await assert.rejects(rpc(record, { command: 'attach-reserve' }), /already/);
    const outer = new Screen(90, 25); screens.push(outer);
    const viewer = pty.spawn(process.execPath, [entry, '__view', record.id, state, reservation.ticket], { cols: 90, rows: 25, cwd: process.cwd(), env: process.env });
    viewers.push(viewer);
    viewer.onExit(() => { const i = viewers.indexOf(viewer); if (i >= 0) viewers.splice(i, 1); });
    viewer.onData(data => { void outer.write(data); });
    outer.onResponse(data => viewer.write(data));
    await until(info, s => s.display === 'attached');
    await until(() => outer.capture('view'), s => s.text.includes('ATTACH_APP'));
    assert.equal((await info()).shellPid, originalPid);
    assert.equal((await outer.capture('view')).buffer, 'alternate');
    assert.equal((await outer.modes()).bracketedPasteMode, true);
    const wheel = await outer.scroll('up', 1, 2, 3);
    viewer.write(wheel);
    await until(read, s => s.text.includes(`INPUT:${Buffer.from(wheel).toString('hex')}`));
    await assert.rejects(rpc(record, { command: 'attach-reserve' }), /already/);
    await rpc(record, { command: 'send', text: 'agent' });
    await until(() => outer.capture('view'), s => s.text.includes('INPUT:6167656e74'));
    await rpc(record, { command: 'send', text: 'query' });
    await until(read, s => s.text.includes('REPORTS:2'));
    await sleep(200);
    assert.doesNotMatch((await read()).text, /REPORTS:3/);
    viewer.resize(100, 30);
    await until(read, s => s.cols === 100 && s.rows === 30);
    viewer.kill();
    await until(info, s => s.display === 'detached');
    assert.equal((await info()).shellPid, originalPid);
    await rpc(record, { command: 'send', text: 'after-disconnect' });
    await until(read, s => s.text.includes('count=3'));

    // Reattach directly to the display transport to check snapshot/live ordering.
    const next = await rpc<{ ticket: string }>(record, { command: 'attach-reserve' });
    const copy = new Screen(100, 30); screens.push(copy);
    const socket = createConnection(displayEndpoint(record)); sockets.push(socket);
    socket.setEncoding('utf8'); socket.on('error', () => {});
    let body = '', ready = false, exitCode: number | undefined;
    socket.on('data', (chunk: string) => {
      body += chunk;
      while (body.includes('\n')) {
        const i = body.indexOf('\n'), event = JSON.parse(body.slice(0, i)) as DisplayEvent; body = body.slice(i + 1);
        if (event.event === 'ready') { ready = true; void copy.write(event.data); }
        if (event.event === 'output') void copy.write(event.data);
        if (event.event === 'exit') exitCode = event.code;
      }
    });
    await new Promise<void>((done, reject) => { socket.once('connect', done); socket.once('error', reject); });
    socket.write(JSON.stringify({ token: record.token, ticket: next.ticket, cols: 100, rows: 30 }) + '\n');
    await until(async () => ready, Boolean);
    await until(() => copy.capture('copy'), s => s.text.includes('count=3'));
    assert.equal((await info()).shellPid, originalPid);
    await rpc(record, { command: 'send', text: 'quit' });
    await until(async () => exitCode, code => code === 7);
    await until(() => copy.capture('copy'), s => s.text.includes('FINAL_OUTPUT'));
    await until(async () => registry.records(), records => records.length === 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    for (const viewer of viewers) { try { viewer.kill(); } catch {} }
    for (const screen of screens) screen.dispose();
    if (record) { try { await rpc(record, { command: 'close' }, 1000); } catch {} }
  }
});
