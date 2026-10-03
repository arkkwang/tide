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
  assert.match(cli().stdout, /AGENT WORKFLOW/);
  for (const command of Object.keys(commandHelp)) {
    const topic = cli("help", command);
    assert.equal(topic.status, 0, topic.stderr);
    assert.match(topic.stdout, /OUTPUT/);
    assert.match(topic.stdout, /EXAMPLE/);
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
  assert.match(detail, /tide send abc123 q --wait-idle --with-read/);
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
  assert.match(detail.stdout, /Does not backfill/);
  assert.match(detail.stdout, /whole current\/latest command region/);
  const invalid = cli('send', 'unused', 'do-not-send', '--full');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /--full requires --with-read/);
});
