import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";

for (const mode of ["raw", "public"]) test(`Windows host forwards ${mode} wheel input, cursor keys and bracketed paste to the inner TUI`, { skip: process.platform !== "win32", timeout: 30000 }, () => {
  mkdirSync(resolve(".tide/tests"), { recursive: true });
  const state = mkdtempSync(resolve(".tide/tests/mouse-"));
  const input = "\x1b[<64;10;10M\x1b[<65;10;10M\x1b[A\x1b[200~hello\nworld\x1b[201~done";
  const result = spawnSync(process.execPath, [resolve("tests/fixtures/mouse-driver.mjs"), input, mode], {
    encoding: "utf8", windowsHide: true, timeout: 25000,
    env: { ...process.env, TIDE_STATE_DIR: state },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const { output, exitCode } = JSON.parse(result.stdout) as { output: string; exitCode: number };
  assert.equal(exitCode, 0, output);
  // Console redraws may split the long line with cursor controls.
  assert(output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r?\n/g, "").includes(`INPUT_HEX:${Buffer.from(input).toString("hex")}`), JSON.stringify(output));
});
