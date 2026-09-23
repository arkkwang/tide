import { test } from "node:test";
import assert from "node:assert/strict";
import { Screen, encodeText } from "../../src/terminal/screen.ts";
import { encodeKey } from "../../src/terminal/keys.ts";
import { resolveSession } from "../../src/session/registry.ts";
import { Plugins, type TidePlugin } from "../../src/plugins/runtime.ts";
import { launchCommand } from "../../src/session/launch.ts";
import type { SessionInfo } from "../../src/session/types.ts";
import { waitIdle } from "../../src/terminal/idle.ts";

test("capture renders split VT sequences, cursor edits, colors and alternate screens", async () => {
  const screen = new Screen(40, 8);
  try {
    await screen.write("\x1b[31");
    await screen.write("mOLD-LONG\rNEW\x1b[K\x1b[0m\r\n中文✓\x1b]0;title\x07");
    const initial = await screen.capture("id");
    assert.equal(initial.text.split("\n")[0], "NEW");
    assert.equal(initial.text.split("\n")[1], "中文✓");
    assert.equal(initial.title, "title");
    assert(!initial.text.includes("\x1b"));
    await screen.write("\x1b[?1049h\x1b[2J\x1b[HAPP\x1b[?2004h");
    assert.equal((await screen.capture("id")).buffer, "alternate");
    assert((await screen.modes()).bracketedPasteMode);
    await screen.write("\x1b[?1049l");
    assert.equal((await screen.capture("id")).text, initial.text);
    screen.resize(50, 10);
    assert.equal((await screen.capture("id")).cols, 50);
    await assert.rejects(screen.capture("id", 0));
  } finally { screen.dispose(); }
});

test("text does not submit and rejects control sequence injection", () => {
  assert.equal(encodeText("/help", true), "\x1b[200~/help\x1b[201~");
  assert.equal(encodeText("/help", false), "/help");
  assert.equal(encodeText("你好\n第二行", true), "\x1b[200~你好\n第二行\x1b[201~");
  assert.throws(() => encodeText("a\nb", false), /bracketed paste/);
  assert.throws(() => encodeText("\x1b[201~rm", true), /send-key/);
  assert.throws(() => encodeText("\x9b31m", true), /send-key/);
});

test("named chords encode terminal keys and reject ambiguous unsupported chords", () => {
  assert.equal(encodeKey("Ctrl+C"), "\x03");
  assert.equal(encodeKey("Ctrl+U"), "\x15");
  assert.equal(encodeKey("Alt+b"), "\x1bb");
  assert.equal(encodeKey("Ctrl+Alt+A"), "\x1b\x01");
  assert.equal(encodeKey("Ctrl+Space"), "\0");
  assert.equal(encodeKey("Shift+Tab"), "\x1b[Z");
  assert.equal(encodeKey("Ctrl+Shift+Left"), "\x1b[1;6D");
  assert.equal(encodeKey("Up", true), "\x1bOA");
  assert.equal(encodeKey("Up", false), "\x1b[A");
  assert.equal(encodeKey("Alt+Delete"), "\x1b[3;3~");
  for (const key of ["Shift+Enter", "Ctrl+Enter", "Win+R", "Ctrl+Ctrl+C", "garbage"]) assert.throws(() => encodeKey(key));
});

test("every caller uses exact or unique prefix matching, never chooses an ambiguous target", () => {
  const records = [{ id: "abc" }, { id: "abcd" }, { id: "def" }];
  assert.equal(resolveSession(records, "abc").id, "abc");
  assert.equal(resolveSession(records, "d").id, "def");
  assert.throws(() => resolveSession(records, "ab"), /abc, abcd/);
  assert.throws(() => resolveSession(records, ""), /nonempty/);
  assert.throws(() => resolveSession(records, "f"), /No session/);
});

test("plugins reuse the input channel, re-detect before writes, and stop observers on disposal", async () => {
  const screen = new Screen(40, 8);
  const session: SessionInfo = { id: "id", pid: 1, shellPid: 2, shell: "shell", cwd: ".", createdAt: "now", exited: false, exitCode: null };
  const writes: string[] = [];
  let active = true, outputs = 0, cleaned = 0;
  const plugin: TidePlugin = {
    id: "fixture", detect: () => active,
    start(context) { const off = context.onOutput(() => { outputs++; }); return () => { cleaned++; off(); }; },
    commands: { resume: { description: "Resume through core", async run(context) { await context.send("continue"); await context.sendKey("Enter"); return "sent"; } } },
  };
  const plugins = new Plugins([plugin], { session, capture: (lines) => screen.capture("id", lines), send: async (text) => { writes.push(text); }, sendKey: async (...keys) => { writes.push(...keys); } });
  try {
    await plugins.start(); plugins.outputChanged();
    assert.equal(outputs, 1);
    assert.equal((await plugins.list())[0]!.matched, true);
    assert.equal(await plugins.run("fixture", "resume", []), "sent");
    assert.deepEqual(writes, ["continue", "Enter"]);
    active = false;
    await assert.rejects(plugins.run("fixture", "resume", []), /does not match/);
    assert.deepEqual((await plugins.list())[0]!.commands, []);
    await plugins.dispose(); plugins.outputChanged();
    assert.equal(outputs, 1); assert.equal(cleaned, 1);
  } finally { screen.dispose(); }
});

test("window launch uses explicit visible Windows window and macOS Terminal", () => {
  const windows = launchCommand("win32", "C:\\Node JS\\node.exe", "D:\\a b\\tide.mjs", "abc", "D:\\a'b", "unused");
  const command = Buffer.from(windows.args.at(-1)!, "base64").toString("utf16le");
  assert(command.includes("-WindowStyle Normal"));
  assert(command.includes("D:\\a''b"));
  assert.deepEqual(launchCommand("darwin", "node", "entry", "abc", "/tmp", "/tmp/start.command"), { binary: "open", args: ["-a", "Terminal", "/tmp/start.command"] });
});

test("wait-idle counts unchanged rendered content, times out on changes and cancels", async () => {
  const screen = new Screen(40, 8);
  try {
    await screen.write('ready');
    const idle = await waitIdle(() => screen.capture('id'), 0.04, 1);
    assert.equal(idle.idle, true); assert(idle.idleForMs >= 40);
    let frame = 0;
    const busy = await waitIdle(async () => ({ ...await screen.capture('id'), text: String(frame++) }), 0.05, 0.15);
    assert.equal(busy.idle, false); assert(busy.elapsedMs >= 150);
    const short = await waitIdle(() => screen.capture('id'), 1, 0);
    assert.equal(short.idle, false);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(waitIdle(() => screen.capture('id'), 1, 2, controller.signal));
    await assert.rejects(waitIdle(() => screen.capture('id'), 0, 1), /idle-time/);
  } finally { screen.dispose(); }
});
