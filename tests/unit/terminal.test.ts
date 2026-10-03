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
import { promptEnv } from "../../src/terminal/shell.ts";
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
  assert.throws(() => encodeText("\x1b[201~rm", true), /send --key/);
  assert.throws(() => encodeText("\x9b31m", true), /send --key/);
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
  assert.deepEqual(windows.args, ["-w", "0", "new-tab", "--profile", "{profile-id}", "--startingDirectory", "D:\\a'b", "C:\\Node JS\\node.exe", "D:\\a b\\tide.mjs", "__host", "abc", "D:\\private state"]);
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

test("bash prompts carry the Tide session marker, other shells keep their own", () => {
  const env = promptEnv("C:\\Program Files\\Git\\bin\\bash.exe", "3c3375b9-8d89-49a5-966b-8145f8a503b7", "");
  assert.match(env.PROMPT_COMMAND!, /^case "\$PS1" in \*"T3c3375b9"\*\)/);
  assert.match(env.PROMPT_COMMAND!, /PS1="T3c3375b9 \$PS1"/);
  assert.doesNotMatch(env.PROMPT_COMMAND!, /45;97|\\e\[/);
  assert.match(promptEnv("bash", "abc", "echo inherited").PROMPT_COMMAND!, /; echo inherited$/);
  assert.doesNotMatch(promptEnv("bash", "abc", "").PROMPT_COMMAND!, /inherited/);
  for (const shell of ["zsh", "pwsh.exe", "cmd.exe", "sh"]) assert.deepEqual(promptEnv(shell, "abc"), {});
});

test("nested bash sessions show only the current Tide marker", () => {
  const outer = promptEnv("bash", "11111111-2222-3333-4444-555555555555", "user_hook");
  const inner = promptEnv("bash", "3c3375b9-8d89-49a5-966b-8145f8a503b7", outer.PROMPT_COMMAND);
  // strips the marker the outer session left in PS1
  assert.match(inner.PROMPT_COMMAND!, /PS1="\$\{PS1\/\/T11111111 \}\"/);
  // keeps its own case but drops the outer one so it cannot re-add its marker
  assert.match(inner.PROMPT_COMMAND!, /case "\$PS1" in \*"T3c3375b9"\*\)/);
  assert.doesNotMatch(inner.PROMPT_COMMAND!, /case "\$PS1" in \*"T11111111"\*\)/);
  // the user's own PROMPT_COMMAND survives
  assert.match(inner.PROMPT_COMMAND!, /; user_hook$/);
  // two levels down: both prior markers are stripped
  const deep = promptEnv("bash", "abcdef01-2222-3333-4444-555555555555", inner.PROMPT_COMMAND);
  assert.match(deep.PROMPT_COMMAND!, /PS1="\$\{PS1\/\/T3c3375b9 \}\"/);
  assert.doesNotMatch(deep.PROMPT_COMMAND!, /case "\$PS1" in \*"T3c3375b9"\*\)/);
  assert.match(deep.PROMPT_COMMAND!, /; user_hook$/);
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

test("read retains whole command blocks, skips only read history, and never consumes plugin captures", async () => {
  const s = new Screen(60, 12);
  const A = '\x1b]133;A\x07', C = '\x1b]133;C\x07';
  try {
    await s.write(`${A}$ one\r\n${C}ONE\r\n${A}$ `);
    assert.match((await s.read('id')).text, /ONE/);
    await s.write(`pull\r\n${C}a: 10%\r\nb: waiting\r\nc: done`);
    const first = await s.read('id');
    assert.doesNotMatch(first.text, /ONE/);
    assert.match(first.text, /Earlier read history omitted/);
    await s.write('\x1b[2A\ra: 90%\x1b[K\x1b[2B');
    const updated = await s.read('id');
    assert.match(updated.text, /a: 90%\nb: waiting\nc: done/);
    await s.write(`\r\n${A}$ `);
    assert.match((await s.read('id')).text, /b: waiting/);
    assert.match((await s.read('id', 20)).text, /b: waiting/);
    assert.doesNotMatch((await s.read('id', 20)).text, /ONE/);
    assert.match((await s.read('id', 20, true)).text, /ONE/);
    await s.write(`two\r\n${C}TWO\r\n${A}$ three\r\n${C}THREE\r\n${A}$ `);
    await s.capture('id');
    const unread = await s.read('id');
    assert.match(unread.text, /TWO/);
    assert.match(unread.text, /THREE/);
    assert.doesNotMatch(unread.text, /b: waiting/);
    assert.doesNotMatch((await s.read('id')).text, /TWO/);
    assert.match((await s.read('id')).text, /THREE/);
  } finally { s.dispose(); }
});

test("read keeps output produced after an earlier read and respects line limits without backfill", async () => {
  const s = new Screen(60, 8);
  const A = '\x1b]133;A\x07', C = '\x1b]133;C\x07';
  try {
    await s.write(`${A}$ one\r\n${C}early`);
    await s.read('id');
    await s.write(`\r\nlate\r\n${A}$ two\r\n${C}short\r\n${A}$ `);
    assert.match((await s.read('id')).text, /late/);
    const limited = await s.read('id', 20);
    assert.doesNotMatch(limited.text, /early|late/);
    assert.match(limited.text, /short/);
    assert.equal(limited.text.split('\n').length, 4); // notice + command/output/prompt
    await assert.rejects(s.read('id', 0));
    await s.write('\x1b[?1049hmenu\r\nunchanged');
    assert.match((await s.read('id')).text, /menu\nunchanged/);
    await s.write('\x1b[?1049l');
    assert.match((await s.read('id')).text, /short/);
    s.resize(40, 8);
    assert.equal((await s.read('id')).omittedHistoryLines, undefined);
  } finally { s.dispose(); }
});

test("read tracks command regions across scrolling, including identical commands", async () => {
  const s = new Screen(40, 4);
  const A = '\x1b]133;A\x07', C = '\x1b]133;C\x07';
  try {
    await s.write(`${A}$ echo SAME\r\n${C}SAME\r\n${A}$ `);
    await s.read('id');
    await s.write(`echo SAME\r\n${C}SAME\r\n${A}$ `);
    const result = await s.read('id');
    assert.equal(result.text.split('\n').filter(l => l === 'SAME').length, 1);
    assert.match(result.text, /echo SAME/);
    assert.equal((await s.read('id', 1)).text.split('\n').at(-1), '$ ');
  } finally { s.dispose(); }
});

test("read is not restricted to viewport height; sessions, resets and retained history stay isolated", async () => {
  const s = new Screen(40, 4), other = new Screen(40, 4);
  const A = '\x1b]133;A\x07', C = '\x1b]133;C\x07';
  try {
    await s.write(`${A}$ long\r\n${C}` + Array.from({length: 20}, (_, i) => `row-${i}\r\n`).join('') + `${A}$ `);
    const all = await s.read('one');
    assert.match(all.text, /row-0\n/);
    assert.match(all.text, /row-19/);
    assert(all.text.split('\n').length > all.rows);
    await other.write(`${A}$ unrelated\r\n${C}OTHER\r\n${A}$ `);
    assert.doesNotMatch((await other.read('two')).text, /omitted|row-/);
    await s.write(`next\r\n${C}new\r\n${A}$ `);
    assert.doesNotMatch((await s.read('one')).text, /row-0/);
    await s.write('\x1b[2J\x1b[Hfresh');
    assert.equal((await s.read('one')).omittedHistoryLines, undefined);
    assert.match((await s.read('one')).text, /fresh/);
    await s.write(`\r\n${A}$ huge\r\n${C}` + 'data\r\n'.repeat(2100));
    const tail = await s.read('one');
    assert(tail.text.split('\n').filter(line => !line.startsWith('[Earlier ')).length <= 2000);
    assert.equal((await s.read('one')).text, tail.text);
    assert.doesNotMatch(tail.text, /fresh|huge/);
    await s.write(`${A}$ after-trim\r\n${C}AFTER\r\n${A}$ `);
    assert.match((await s.read('one')).text, /AFTER/);
  } finally { s.dispose(); other.dispose(); }
});

test("read trims unused bottom rows on shell, command-region and alternate-screen paths", async () => {
  const shell = new Screen(20, 6);
  try {
    await shell.write('one\r\ntwo\r\nthree');
    const screen = await shell.read('id');
    assert.equal(screen.text, 'one\ntwo\nthree');
    assert.equal(screen.cursor?.row, 2);
    assert.equal(screen.rows, 6, "cols/rows still report terminal size, not returned text size");
    assert.equal((await shell.read('id', 1)).text, 'three', "line limit takes the trimmed tail, not window padding");
    assert.equal((await shell.read('id', 2)).text, 'two\nthree');
    const captured = await shell.capture('id');
    assert.equal(captured.text, 'one\ntwo\nthree\n\n\n', "internal capture keeps the full window for idle detection");
    assert.equal(captured.cursor?.row, 2);
  } finally { shell.dispose(); }
  const A = '\x1b]133;A\x07', C = '\x1b]133;C\x07';
  const integrated = new Screen(20, 6);
  try {
    await integrated.write(`${A}$ ls\r\n${C}file`);
    const region = await integrated.read('id');
    assert.equal(region.text, '$ ls\nfile');
    assert.equal(region.cursor?.row, 1);
    const tail = await integrated.read('id', 1);
    assert.equal(tail.text, '[Earlier content outside line limit: 1 lines]\nfile');
    assert.equal(tail.limitedLines, 1);
    assert.equal(tail.cursor?.row, 1, 'cursor includes the existing omission notice');
  } finally { integrated.dispose(); }
  const tui = new Screen(20, 5);
  try {
    await tui.write('\x1b[?1049hmenu\r\nbody');
    const alt = await tui.read('id');
    assert.equal(alt.text, 'menu\nbody');
    assert.equal(alt.buffer, 'alternate');
    assert.equal(alt.cursor?.row, 1);
    assert.equal(alt.rows, 5);
    assert.equal((await tui.capture('id')).text, 'menu\nbody\n\n\n');
  } finally { tui.dispose(); }
});

test("read retains blank rows up to the cursor, original spacing and --full scrollback", async () => {
  const blank = new Screen(20, 4);
  try {
    const empty = await blank.read('id');
    assert.equal(empty.text, '', "a fresh screen keeps only the cursor row");
    assert.equal(empty.cursor?.row, 0);
    await blank.write('\x1b[3B');
    const lower = await blank.read('id');
    assert.equal(lower.text, '\n\n\n', "blank rows down to the cursor row stay");
    assert.equal(lower.cursor?.row, 3);
  } finally { blank.dispose(); }
  const middle = new Screen(20, 6);
  try {
    await middle.write('one\r\n\r\nthree\r\n');
    const result = await middle.read('id');
    assert.equal(result.text, 'one\n\nthree\n');
    assert.equal(result.cursor?.row, 3, 'retain both interior blanks and the blank cursor row');
    assert.equal((await middle.read('id', undefined, true)).text, result.text);
  } finally { middle.dispose(); }
  const spaced = new Screen(20, 6);
  try {
    await spaced.write('  keep  me  \r\n   \r\n\t');
    await spaced.write('\x1b[2A');
    assert.equal((await spaced.read('id')).text, '  keep  me  ', "whitespace-only rows count as unused padding");
  } finally { spaced.dispose(); }
  const scrolled = new Screen(20, 4);
  try {
    await scrolled.write(Array.from({ length: 10 }, (_, i) => `l${i}`).join('\r\n') + '\x1b[2K\x1b[1A\x1b[2K');
    const current = await scrolled.read('id');
    assert.equal(current.text, 'l6\nl7\n', "default read stays inside the window and drops padding");
    assert.equal(current.cursor?.row, 2);
    const full = await scrolled.read('id', undefined, true);
    assert.equal(full.text, 'l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7\n');
    assert.equal(full.cursor?.row, 8, "cursor row still indexes the returned text");
    assert.equal((await scrolled.read('id', 3)).text, 'l6\nl7\n');
  } finally { scrolled.dispose(); }
});
