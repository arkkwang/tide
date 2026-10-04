import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { commandHelp } from "../../src/cli/help.ts";

const cli = (...args: string[]) => spawnSync(process.execPath, [resolve("dist/tide.mjs"), ...args], {
  encoding: "utf8", windowsHide: true, timeout: 5000,
  env: { ...process.env, TIDE_STATE_DIR: resolve("package.json") }, // Cannot be used as a session directory.
});

test("all public commands expose help without accessing sessions or launching shells", () => {
  const overview = cli().stdout;
  assert.match(overview, /COMMANDS/);
  assert.match(overview, /Text does not auto-submit; use --with-enter/);
  assert.match(overview, /written acknowledges input delivery/);
  assert.doesNotMatch(overview, /AGENT WORKFLOW|SAFETY AND RESULTS|ENVIRONMENT/);
  for (const command of Object.keys(commandHelp)) {
    const topic = cli("help", command);
    assert.equal(topic.status, 0, topic.stderr);
    assert(topic.stdout.startsWith(`tide ${command}`), topic.stdout);
    assert.equal(topic.stdout.trimEnd(), commandHelp[command]);
    for (const flag of ["--help", "-h"]) {
      const result = cli(command, flag);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, topic.stdout);
    }
  }
});

test("invalid help and commands fail with actionable guidance", () => {
  for (const args of [["help", "missing"], ["missing"], ["help", "send", "extra"], ["send"]]) {
    const result = cli(...args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /help/);
  }
  assert.match(cli("missing").stderr, /Unknown command/);
});

test("launch validates combined options before opening a terminal", () => {
  for (const [args, message] of [
    [["launch", "--with-command"], /needs a command/],
    [["launch", "--with-command", ""], /needs a command/],
    [["launch", "--with-command", "echo ok", "--with-command", "echo twice"], /only be supplied once/],
    [["launch", "--with-command", "echo ok\nexit"], /single line/],
    [["launch", "--with-command", "echo ok", "--lines", "5"], /requires --with-read/],
    [["launch", "--with-command", "echo ok", "--timeout", "1"], /require --wait-idle/],
    [["launch", "--with-command", "echo ok", "--with-read", "--lines", "0"], /1..2000/],
    [["launch", "--with-command", "echo ok", "--with-enter"], /Unknown operation option/],
    [["launch", "--with-read"], /require --with-command/],
    [["run", "--with-command", "echo ok"], /Unknown launch option/],
  ] as Array<[string[], RegExp]>) {
    const result = cli(...args);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
  }
});

test("send help explains literal input, ordered keys and exclusive modes without an old entry", () => {
  const overview = cli().stdout;
  const detail = cli("help", "send").stdout;
  assert.match(overview, /send <id> --key/);
  assert.doesNotMatch(overview + detail, /send-key/);
  assert.equal(Object.hasOwn(commandHelp, "send-key"), false);
  assert.match(detail, /Enter types the word; --key Enter/);
  assert.match(detail, /in order, not simultaneously/);
  assert.match(detail, /cannot combine with text, --stdin or --with-enter/);
  assert.match(detail, /Put options AFTER text\/keys/);
  assert.match(detail, /--with-enter submits text/);
  assert.equal(cli("help", "send-key").status, 1);
  assert.match(cli("send-key", "unused", "Enter").stderr, /Unknown command/);
});

test("send rejects mixed modes and malformed sequences before contacting a session", () => {
  for (const [args, message] of [
    [["text", "--key", "Enter"], /Text cannot combine.*--with-enter/],
    [["text", "--with-enter", "--key", "Enter"], /Text cannot combine/],
    [["--stdin", "--key", "Enter"], /Text cannot combine/],
    [["--key", "Enter", "--stdin"], /Choose one input mode/],
    [["--key", "Up", "--key", "Enter"], /Choose one input mode/],
    [["--key", "Enter", "--with-enter"], /append Enter/],
    [["--key"], /1\.\.64 keys/],
    [["--key", "--with-read"], /1\.\.64 keys/],
    [["--key", ...Array(65).fill("Enter")], /1\.\.64 keys/],
    [["--key", "Enter", "--with-captur"], /Unknown operation option/],
  ] as Array<[string[], RegExp]>) {
    const result = cli("send", "unused", ...args);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
    assert.match(result.stderr, /Usage help: tide help send/);
  }
});

test("read replaces capture and documents region, full and line-limit behavior", () => {
  assert.equal(cli('help', 'capture').status, 1);
  const detail = cli('help', 'read');
  assert.equal(detail.status, 0);
  assert.match(detail.stdout, /--full/);
  assert.match(detail.stdout, /Last N lines/);
  assert.match(detail.stdout, /current\/latest command/);
  const invalid = cli('send', 'unused', 'do-not-send', '--full');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /--full requires --with-read/);
});


test("read help states scope and options without prescribing a reading strategy", () => {
  const detail = commandHelp.read!;
  assert.match(detail, /current\/latest command/);
  assert.match(detail, /current screen without command markers/);
  assert.match(detail, /Complete retained selected range/);
  assert.match(detail, /Last N lines/);
  assert.match(detail, /mutually exclusive/);
  const allHelp = cli().stdout + Object.values(commandHelp).join('\n');
  assert.doesNotMatch(allHelp, /first 10|last 30|40 lines|only for missing evidence|routinely fill omissions/);
});

test("full and lines conflict before session access or side effects", () => {
  const operations = [
    ['read', 'unused'],
    ['send', 'unused', 'NEVER_INVALID_INPUT', '--with-enter', '--with-read'],
    ['wait-idle', 'unused', '--with-read'],
    ['scroll', 'unused', 'up', '--with-read'],
    ['resize', 'unused', '--cols', '100', '--rows', '30', '--with-read'],
    ['launch', '--with-command', 'echo ok', '--with-read'],
  ];
  for (const operation of operations) {
    for (const options of [['--full', '--lines', '5'], ['--lines', '5', '--full']]) {
      const result = cli(...operation, ...options);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /--full and --lines are mutually exclusive/);
    }
  }
});

test("local help keeps parameter contracts rather than workflow instructions", () => {
  assert.match(commandHelp.send!, /failed requests may have delivered input/);
  assert.match(commandHelp.launch!, /Startup timeout sends nothing/);
  assert.match(commandHelp.launch!, /require --with-command or --profile/);
  assert.match(commandHelp.resize!, /applied=false, exit 3/);
  assert.match(commandHelp['wait-idle']!, /leaves the task running/);
  assert.match(commandHelp.close!, /including ongoing work/);
  assert.match(commandHelp.plugin!, /NEW sessions/);
  assert.match(commandHelp.plugin!, /loads and validates local code/);
  assert.match(commandHelp.plugin!, /consume tokens/);
  for (const command of ['launch', 'send', 'scroll', 'resize', 'wait-idle']) {
    assert.match(commandHelp[command]!, /--lines\/--full require --with-read/);
    assert.match(commandHelp[command]!, /--full and --lines are mutually exclusive/);
    assert.match(commandHelp[command]!, /default 3/);
    assert.match(commandHelp[command]!, /default 30/);
  }
});

test("overview includes common call syntax without requiring command help", () => {
  const overview = cli().stdout;
  for (const syntax of [
    'launch [--shell executable] [--cwd directory] [--with-command text | --profile label]',
    'send <id> <text> [--with-enter]',
    'send <id> --stdin [--with-enter]',
    'send <id> --key <key> [keys...]',
    'read <id> [--full | --lines N] [--plain-text]',
    'wait-idle <id> [--idle-time N] [--timeout N] [--with-read]',
    '--wait-idle [--idle-time N] [--timeout N]',
    '--with-read [--full | --lines N]',
  ]) assert(overview.includes(syntax), syntax);
  assert.doesNotMatch(overview, /\[options\]|\[shell options\]/);
  for (const command of ['list', 'info', 'close']) {
    assert.equal(commandHelp[command]!.split('\n').length, 3);
  }
});
