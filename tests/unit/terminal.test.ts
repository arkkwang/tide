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
import { commandRegionEnv, promptEnv } from "../../src/terminal/shell.ts";
import { setTimeout as sleep } from "node:timers/promises";

test("session activity tracks rendered changes independently of raw output and reads", async () => {
  let now = 1000;
  const screen = new Screen(40, 8, () => now);
  try {
    now += 500;
    assert.deepEqual(await screen.activity(), { idleForMs: 500, lastOutputAt: null, lastCommand: null });
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
  const windows = launchCommand("win32", "C:\\Node JS\\node.exe", "D:\\a b\\tide.mjs", "abc", "D:\\a'b", "unused", { state: "D:\\private state", profile: "{profile-id}", ticket: "ticket" });
  assert.equal(windows.binary, "wt.exe");
  assert.deepEqual(windows.args, ["-w", "0", "new-tab", "--profile", "{profile-id}", "--startingDirectory", "D:\\a'b", "C:\\Node JS\\node.exe", "D:\\a b\\tide.mjs", "__view", "abc", "D:\\private state", "ticket"]);
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

test("read trims unused bottom rows on shell, command-region and alternate-screen paths", async () => {
  const shell = new Screen(20, 6);
  try {
    await shell.write('one\r\ntwo\r\nthree');
    const screen = await shell.read('id');
    assert.equal(screen.text, 'one\ntwo\nthree');
    assert.equal(screen.cursor?.row, 2);
    assert.equal(screen.rows, 6, "cols/rows still report terminal size, not returned text size");
    assert.equal((await shell.read('id', 1)).text, '[... earlier output omitted ...]\nthree', "line limit takes the trimmed tail, not window padding");
    assert.equal((await shell.read('id', 2)).text, '[... earlier output omitted ...]\ntwo\nthree');
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
    assert.equal(tail.text, '[... earlier output omitted ...]\nfile');
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

test("read retains blank rows up to the cursor, original spacing and viewport scope", async () => {
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
    assert.equal(full.text, current.text);
    assert.equal(full.cursor?.row, 2, "cursor row still indexes the returned text");
    assert.equal((await scrolled.read('id', 3)).text, current.text);
  } finally { scrolled.dispose(); }
});



const A = '\x1b]133;A\x07', C = '\x1b]133;C\x07';

test("reads select only the latest command, independent of earlier observations", async () => {
  for (const observe of [false, true]) {
    const s = new Screen(40, 70);
    try {
      await s.write(`${A}$ old\r\n${C}` + 'OLD\r\n'.repeat(50) + `${A}$ `);
      if (observe) assert.match((await s.read('id')).text, /middle output omitted/);
      await s.write(`new\r\n${C}early`);
      assert.equal((await s.read('id')).text, '$ new\nearly');
      await s.write('\rlater\x1b[K');
      assert.equal((await s.read('id')).text, '$ new\nlater');
      await s.write(`\r\n${A}$ `);
      for (const [lines, full] of [[undefined, false], [undefined, true], [100, false]] as const) {
        const r = await s.read('id', lines, full);
        assert.equal(r.text, '$ new\nlater\n$ ');
        assert.equal((await s.read('id', lines, full)).text, r.text);
      }
      await s.write(`unread\r\n${C}UNREAD\r\n${A}$ newest\r\n${C}NEWEST`);
      assert.equal((await s.read('id', undefined, true)).text, '$ newest\nNEWEST');
      await assert.rejects(s.read('id', 5, true), /mutually exclusive/);
      for (const n of [0, 2001, 1.5]) await assert.rejects(s.read('id', n), /1..2000/);
    } finally { s.dispose(); }
  }
});

test("command preview boundaries, full content, tails and cursor mapping", async () => {
  for (const count of [1, 9, 10, 30, 39, 40, 41, 60]) {
    const s = new Screen(40, 70);
    const rows = Array.from({ length: count }, (_, i) => `row-${i}`);
    try {
      await s.write(A + C + rows.join('\r\n'));
      const r = await s.read('id');
      const expected = count <= 40 ? rows : [...rows.slice(0, 10), '[... middle output omitted ...]', ...rows.slice(-30)];
      assert.deepEqual(r.text.split('\n'), expected);
      assert.equal(r.cursor?.row, expected.length - 1);
      assert.equal((await s.read('id', undefined, true)).text, rows.join('\n'));
      for (const n of [1, 5, 100]) {
        const tail = await s.read('id', n);
        assert.deepEqual(tail.text.split('\n'), count > n ? ['[... earlier output omitted ...]', ...rows.slice(-n)] : rows);
        assert.equal(tail.cursor?.row, Math.min(count, n) - 1 + Number(count > n));
      }
      if (count > 40) {
        await s.write('\x1b[1;1H');
        assert.equal((await s.read('id')).cursor?.row, 0);
        assert.equal((await s.read('id', 5)).cursor, undefined);
        await s.write('\x1b[11;1H');
        const hidden = await s.read('id');
        assert.equal(hidden.cursor, undefined);
        assert.match(hidden.text, /middle output omitted; cursor omitted/);
        assert.equal((await s.read('id', undefined, true)).cursor?.row, 10);
      }
    } finally { s.dispose(); }
  }
});

test("unmarked shells and TUIs keep the complete viewport, never backfill history", async () => {
  for (const alternate of [false, true]) {
    const s = new Screen(40, 60);
    try {
      const rows = Array.from({ length: 50 }, (_, i) => `row-${i}`);
      await s.write((alternate ? '\x1b[?1049h' : '') + rows.join('\r\n'));
      assert.equal((await s.read('id')).text, rows.join('\n'));
      assert.equal((await s.read('id', undefined, true)).text, rows.join('\n'));
      assert.equal((await s.read('id', 5)).text, '[... earlier output omitted ...]\n' + rows.slice(-5).join('\n'));
      assert.equal((await s.capture('id')).text.split('\n').length, 60);
      await s.write('\r\n' + Array.from({length: 70}, (_, i) => `extra-${i}`).join('\r\n'));
      const viewport = (await s.capture('id')).text;
      for (const [lines, full] of [[undefined, false], [undefined, true], [100, false]] as const)
        assert.equal((await s.read('id', lines, full)).text, viewport);
    } finally { s.dispose(); }
  }
});

test("retained command output survives scrollback eviction; reset and sessions stay isolated", async () => {
  const s = new Screen(40, 4), other = new Screen(40, 4);
  try {
    await s.write(`${A}$ huge\r\n${C}` + 'data\r\n'.repeat(2100));
    assert.equal((await s.read('id')).text.split('\n').length, 41);
    const full = await s.read('id', undefined, true);
    assert.equal(full.text.split('\n').length, 2004);
    assert.doesNotMatch(full.text, /huge/);
    await other.write(`${A}$ other\r\n${C}OTHER`);
    assert.doesNotMatch((await other.read('other')).text, /data/);
    await s.write(`${A}$ next\r\n${C}NEXT\r\n${A}$ `);
    assert.equal((await s.read('id')).text, '$ next\nNEXT\n$ ');
    await s.write('\x1b[?1049h\x1b[HMENU');
    assert.equal((await s.read('id')).text, 'MENU');
    await s.write('\x1b[?1049l');
    assert.match((await s.read('id')).text, /NEXT/);
    s.resize(40, 5);
    assert.equal((await s.read('id')).text, (await s.read('id', undefined, true)).text);
    await s.write('\x1b[2J\x1b[Hfresh');
    assert.equal((await s.read('id')).text, 'fresh');
    await s.write(`\r\n${A}$ again\r\n${C}AGAIN`);
    assert.equal((await s.read('id')).text, '$ again\nAGAIN');
  } finally { s.dispose(); other.dispose(); }
});

test("lastCommand tracks executed input, not prompts, output or TUI input", async () => {
  const screen = new Screen(40, 8);
  const B = '\x1b]133;B\x07';
  try {
    assert.equal((await screen.activity()).lastCommand, null);
    await screen.write(`${A}multi-line prompt\r\n$ ${B}echo old`);
    assert.equal((await screen.activity()).lastCommand, null, 'typing is not execution');
    await screen.write(`\x1b[3Dnew\r\n${C}new\r\n${A}$ ${B}`);
    assert.equal((await screen.activity()).lastCommand, 'echo new');
    await screen.write('cancel me\r\n^C\r\n' + A + '$ ' + B);
    assert.equal((await screen.activity()).lastCommand, 'echo new');
    await screen.write(`claude\r\n${C}\x1b[?1049hchat input\r\nmore chat`);
    assert.equal((await screen.activity()).lastCommand, 'claude');
    screen.resize(50, 10);
    await screen.write('\x1b[2J\x1b[H');
    assert.equal((await screen.activity()).lastCommand, 'claude', 'resize/clear preserve executed command');
    await screen.write(`\x1b[?1049l\r\n${A}$ ${B}pwd\r\n${C}/tmp\r\n`);
    assert.equal((await screen.activity()).lastCommand, 'pwd');
  } finally { screen.dispose(); }
});

test("lastCommand joins soft wraps and rejects unrecognized or multiline input", async () => {
  const screen = new Screen(20, 6);
  const B = '\x1b]133;B\x07';
  try {
    const command = 'echo 123456789012345678901234567890';
    await screen.write(`${A}$ ${B}${command}\r\n${C}`);
    assert.equal((await screen.activity()).lastCommand, command);
    await screen.write(`\r\n${A}$ ${B}echo 'first\r\n> second'\r\n${C}`);
    assert.equal((await screen.activity()).lastCommand, null, 'do not mistake PS2 for command text');
    await screen.write(`\r\n${A}$ pwd\r\n${C}`);
    assert.equal((await screen.activity()).lastCommand, null, 'old integration without B is unknown');
    await screen.write(`\r\n${A}$ ${B}pwd`);
    screen.resize(25, 6);
    await screen.write(`\r\n${C}`);
    assert.equal((await screen.activity()).lastCommand, null, 'lost input boundary is unknown');
  } finally { screen.dispose(); }
});

test("Bash command integration marks prompt end without duplicating hooks", () => {
  const env = commandRegionEnv('bash', promptEnv('bash', 'abc', ''));
  assert.match(env.PROMPT_COMMAND!, /133;B/);
  assert.deepEqual(commandRegionEnv('bash', env), env);
  assert.deepEqual(commandRegionEnv('pwsh', { PROMPT_COMMAND: 'existing' }), { PROMPT_COMMAND: 'existing' });
});

test("lastCommand excludes wide-wrap padding but preserves literal input whitespace", async () => {
  const B = '\x1b]133;B\x07';
  for (const command of ['echo 123456789012中', 'printf foo\\ ', '  echo keep  spaces  ', 'echo 1234567890123中', 'echo 12345678901 中']) {
    const screen = new Screen(20, 6);
    try {
      await screen.write(`${A}$ ${B}${command}\r\n${C}`);
      assert.equal((await screen.activity()).lastCommand, command);
    } finally { screen.dispose(); }
  }
});
