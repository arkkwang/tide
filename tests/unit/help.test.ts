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
