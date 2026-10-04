import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Display, displayEndpoint, type DisplayEvent } from "../../src/session/display.ts";
import { Screen } from "../../src/terminal/screen.ts";
import type { SessionRecord } from "../../src/session/types.ts";

const snapshot = async (screen: Screen) => {
  const { text, cursor, buffer, title } = await screen.capture('test');
  return { text, cursor, buffer, title };
};

test("serialized terminal restores color, cursor, buffers and input modes, not a read preview", async () => {
  const original = new Screen(40, 8), restored = new Screen(40, 8);
  try {
    await original.write('\x1b[31mRED\r\nnormal\x1b]2;fixture\x07\x1b[?1049h\x1b[H\x1b[32mMENU\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?25l');
    const serialized = await original.serialize();
    assert.match(serialized, /\x1b\[31m/);
    assert.match(serialized, /\x1b\[32m/);
    assert.match(serialized, /\x1b\[\?25l/);
    assert.doesNotMatch(serialized, /output omitted/);
    await restored.write(serialized);
    assert.deepEqual(await snapshot(restored), await snapshot(original));
    assert.deepEqual(await restored.modes(), await original.modes());
    assert.equal(await restored.scroll('up', 1, 2, 3), await original.scroll('up', 1, 2, 3));
    await original.write('\x1b[?1049l'); await restored.write('\x1b[?1049l');
    assert.deepEqual(await snapshot(restored), await snapshot(original));
  } finally { original.dispose(); restored.dispose(); }
});

test("serialized terminal preserves pending wrap and scrolling-region behavior", async () => {
  for (const initial of ['x'.repeat(40), '\x1b[2;6r\x1b[?6h\x1b[3;1Hbody', '\x1b[?1049h\x1b[2;6r\x1b[6;1Hbottom']) {
    const original = new Screen(40, 8), restored = new Screen(40, 8);
    try {
      await original.write(initial);
      await restored.write(await original.serialize());
      assert.deepEqual(await snapshot(restored), await snapshot(original));
      for (const data of ['NEXT', '\r\n'.repeat(8) + 'END']) {
        await original.write(data); await restored.write(data);
        assert.deepEqual(await snapshot(restored), await snapshot(original));
      }
    } finally { original.dispose(); restored.dispose(); }
  }
});

test("attachment between split escape sequences preserves the parser suffix", async () => {
  for (const [prefix, suffix] of [
    ['before\x1b[3', '1mRED'],
    ['before\x1b]2;partial', '-title\x07after'],
    ['before\x1b(', '0q\x1b(Bafter'],
    ['before\x1bPignored', '\x1b\\after'],
    ['before\x1b', '[2;1Hafter'],
  ]) {
    const original = new Screen(40, 8), restored = new Screen(40, 8);
    try {
      await original.write(prefix!);
      await restored.write(await original.serialize());
      await original.write(suffix!); await restored.write(suffix!);
      assert.deepEqual(await snapshot(restored), await snapshot(original));
    } finally { original.dispose(); restored.dispose(); }
  }
});

test("headless screen emits cursor reports without a visible terminal", async () => {
  const screen = new Screen(40, 8), replies: string[] = [];
  const listener = screen.onResponse(data => replies.push(data));
  try {
    await screen.write('\x1b[3;5H\x1b[6n');
    assert.deepEqual(replies, ['\x1b[3;5R']);
    listener.dispose();
    await screen.write('\x1b[6n');
    assert.equal(replies.length, 1);
  } finally { screen.dispose(); }
});

function record(): SessionRecord {
  const id = randomUUID();
  return { id, pid: 1, shellPid: 2, shell: 'test', cwd: '.', createdAt: '', exited: false, exitCode: null,
    endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\tide-test-${id}` : join(tmpdir(), `tide-test-${id}`), token: randomUUID() };
}

test("display slot rejects duplicates, authenticates, releases on disconnect and expires reservations", async () => {
  const r = record(), inputs: string[] = [], sizes: number[][] = [];
  const display = new Display(r, {
    connect: async (_cols, _rows, install) => { install('SNAPSHOT'); },
    input: async data => { inputs.push(data); },
    resize: async (cols, rows) => { sizes.push([cols, rows]); },
  }, 1000);
  const sockets: ReturnType<typeof createConnection>[] = [];
  const connect = (token: string, ticket: string) => {
    const events: DisplayEvent[] = [];
    const socket = createConnection(displayEndpoint(r)); sockets.push(socket);
    socket.setEncoding('utf8'); socket.on('error', () => {});
    let body = '';
    socket.on('data', (chunk: string) => {
      body += chunk;
      while (body.includes('\n')) { const i = body.indexOf('\n'); events.push(JSON.parse(body.slice(0, i))); body = body.slice(i + 1); }
    });
    socket.once('connect', () => socket.write(JSON.stringify({ token, ticket, cols: 80, rows: 25 }) + '\n'));
    return { socket, events };
  };
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100; i++) { if (check()) return; await sleep(10); }
    assert.fail('Display state did not settle');
  };
  try {
    await display.start();
    const { ticket } = display.reserve();
    assert.equal(display.state, 'opening'); assert.throws(() => display.reserve(), /already/);
    const denied = connect('wrong', ticket);
    await until(() => denied.events.some(e => e.event === 'error'));
    assert.equal(display.state, 'opening');
    const first = connect(r.token, ticket);
    await until(() => first.events.some(e => e.event === 'ready'));
    assert.equal(display.status(ticket), 'attached');
    assert.throws(() => display.reserve(), /already/);
    display.cancel(ticket); assert.equal(display.state, 'attached');
    display.output('LIVE');
    first.socket.write(JSON.stringify({ command: 'input', data: 'hello' }) + '\n' + JSON.stringify({ command: 'resize', cols: 90, rows: 30 }) + '\n');
    await until(() => inputs.length === 1 && sizes.length === 1 && first.events.some(e => e.event === 'output'));
    assert.deepEqual(inputs, ['hello']); assert.deepEqual(sizes, [[90, 30]]);
    const duplicate = connect(r.token, ticket);
    await until(() => duplicate.events.some(e => e.event === 'error'));
    assert.equal(display.state, 'attached');
    first.socket.destroy(); await until(() => display.state === 'detached');
    const expired = display.reserve();
    await sleep(1050); assert.equal(display.state, 'detached');
    assert.throws(() => display.status(expired.ticket), /expired/);
    const next = display.reserve(); display.cancel(expired.ticket);
    assert.equal(display.state, 'opening');
    display.cancel(next.ticket); assert.equal(display.state, 'detached');
  } finally { sockets.forEach(s => s.destroy()); display.dispose(); }
});
