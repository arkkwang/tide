import { test } from "node:test";
import assert from "node:assert/strict";
import { Screen, encodeText } from "../../src/terminal/screen.ts";
import { encodeKey } from "../../src/terminal/keys.ts";
import { resolveSession } from "../../src/session/registry.ts";
import { Plugins, type TidePlugin } from "../../src/plugins/runtime.ts";
import { launchCommand } from "../../src/session/launch.ts";
import type { SessionInfo } from "../../src/session/types.ts";
import { waitIdle } from "../../src/terminal/idle.ts";
import { requestResize } from "../../src/terminal/resize.ts";
import { defaultProfile, windowsTerminalProfile } from "../../src/terminal/windows-profile.ts";
import { setTimeout as sleep } from "node:timers/promises";

test("session activity tracks rendered changes independently of raw output and reads", async () => {
  let now = 1000;
  const screen = new Screen(40, 8, () => now);
  try {
    now += 500;
    assert.deepEqual(await screen.activity(), { idleForMs: 500, lastOutputAt: null });
    await screen.write("hello");
    const first = await screen.activity();
    assert.equal(first.idleForMs, 0);
    assert(Number.isFinite(Date.parse(first.lastOutputAt!)));
    now += 1000;
    await sleep(5);
    await screen.write("\r\x1b[31mhello\x1b[0m\x1b]0;new title\x07");
    assert.equal((await screen.activity()).idleForMs, 1000);
    assert.notEqual((await screen.activity()).lastOutputAt, first.lastOutputAt);
    await screen.capture("id", 1);
    assert.equal((await screen.activity()).idleForMs, 1000);
    await screen.write("\rworld");
    await screen.write("\rhello");
    assert.equal((await screen.activity()).idleForMs, 0, "changes between info polls still reset idle");
    now += 500;
    screen.resize(40, 8);
    assert.equal((await screen.activity()).idleForMs, 500);
    const beforeResize = (await screen.activity()).lastOutputAt;
    screen.resize(50, 10);
    assert.equal((await screen.activity()).idleForMs, 0);
    assert.equal((await screen.activity()).lastOutputAt, beforeResize);
    now += 500;
    await screen.write("\x1b[?1049h");
    assert.equal((await screen.activity()).idleForMs, 0);
  } finally { screen.dispose(); }
});

test("scroll follows mouse modes, validates cells and never falls back to keys", async () => {
  const screen = new Screen(100, 30);
  try {
    await assert.rejects(screen.scroll("up", 1), /SGR/);
    await screen.write("\x1b[?1000;1006h");
    assert.equal(await screen.scroll("up", 2), "\x1b[<64;50;15M".repeat(2));
    assert.equal(await screen.scroll("down", 1, 1, 30), "\x1b[<65;1;30M");
    await assert.rejects(screen.scroll("up", 0));
    await assert.rejects(screen.scroll("left", 1));
    await assert.rejects(screen.scroll("up", 1, 101, 1));
    await screen.write("\x1b[?1016h");
    await assert.rejects(screen.scroll("up", 1), /SGR/);
    await screen.write("\x1b[?1016l\x1b[?1000l");
    await assert.rejects(screen.scroll("up", 1), /SGR/);
    await screen.write("\x1b[?1000h\x1bc\x1b[?1000h");
    await assert.rejects(screen.scroll("up", 1), /SGR/);
  } finally { screen.dispose(); }
});

test("resize observes actual dimensions and reports unconfirmed requests without forcing them", async () => {
  const signal = new AbortController().signal;
  let actual = { cols: 80, rows: 24 }, writes = 0;
  const write = (data: string) => { assert.equal(data, "\x1b[8;30;100t"); writes++; actual = { cols: 100, rows: 30 }; };
  assert.equal((await requestResize(100, 30, () => actual, write, signal)).applied, true);
  await requestResize(100, 30, () => actual, write, signal);
  assert.equal(writes, 1);
  const refused = await requestResize(120, 35, () => actual, () => {}, signal, 0);
  assert.equal(refused.applied, false); assert.deepEqual(refused.actual, actual);
  await assert.rejects(requestResize(0, 35, () => actual, write, signal));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(requestResize(100, 30, () => actual, write, abort.signal));
});

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
  assert.equal(encodeText("/help", true), "/help");
  assert.equal(encodeText("/help", false), "/help");
  assert.equal(encodeText("你好\n第二行", true), "\x1b[200~你好\n第二行\x1b[201~");
  assert.equal(encodeText("a\tb", true), "\x1b[200~a\tb\x1b[201~");
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
    id: "fixture", name: "Fixture plugin", detect: () => active,
    start(context) { const off = context.onOutput(() => { outputs++; }); return () => { cleaned++; off(); }; },
    commands: { resume: { description: "Resume through core", async run(args, context) { assert.deepEqual(args, []); await context.send!("continue"); await context.sendKey!("Enter"); return "sent"; } } },
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

test("window launch uses Windows Terminal profiles without shell interpolation", () => {
  const windows = launchCommand("win32", "C:\\Node JS\\node.exe", "D:\\a b\\tide.mjs", "abc", "D:\\a'b", "unused", { state: "D:\\private state", profile: "{profile-id}" });
  assert.equal(windows.binary, "wt.exe");
  assert.deepEqual(windows.args, ["-w", "new", "new-tab", "--profile", "{profile-id}", "--startingDirectory", "D:\\a'b", "C:\\Node JS\\node.exe", "D:\\a b\\tide.mjs", "__host", "abc", "D:\\private state"]);
  const defaults = launchCommand("win32", "node", "entry", "abc", "cwd", "unused", { state: "state" });
  assert(!defaults.args.includes("--profile"));
  assert(launchCommand("win32", "node", "entry", "abc", "D:\\semi;colon", "unused", { state: "state" }).args.includes("D:\\semi\\;colon"));
  assert.deepEqual(launchCommand("darwin", "node", "entry", "abc", "/tmp", "/tmp/start.command"), { binary: "open", args: ["-a", "Terminal", "/tmp/start.command"] });
});

test("Windows Terminal default profile handles JSONC without matching comments or nested fields", () => {
  assert.equal(defaultProfile(`{ // "defaultProfile": "wrong"
    "profiles": {"defaultProfile": "nested"},
    "defaultProfile": /* user choice */ "{actual}",
  }`), "{actual}");
  assert.equal(defaultProfile('{"profiles":{"defaultProfile":"nested"}}'), undefined);
  assert.equal(windowsTerminalProfile({ WT_PROFILE_ID: "{current}" }), "{current}");
  assert.throws(() => windowsTerminalProfile({}), /preferred Windows Terminal profile/);
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
