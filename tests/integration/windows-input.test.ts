import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import xterm from "@xterm/headless";

test("Windows VT relay preserves LF columns and leaves no ghost after a partial repaint", { skip: process.platform !== "win32", timeout: 30000 }, async () => {
  for (const mode of ["legacy", "fixed"]) {
    const result = spawnSync(process.execPath, [resolve("tests/fixtures/output-mode-driver.mjs"), mode], { encoding: "utf8", windowsHide: true, timeout: 14000 });
    assert.equal(result.status, 0, result.stderr);
    const { output, exitCode } = JSON.parse(result.stdout);
    assert.equal(exitCode, 0);
    const screen = new xterm.Terminal({ cols: 40, rows: 10, allowProposedApi: true });
    try {
      await new Promise<void>((done) => screen.write(output, done));
      const line = (row: number) => screen.buffer.active.getLine(row)!.translateToString(true).trimEnd();
      assert.equal(line(1), " h");
      assert.equal(line(2), mode === "legacy" ? "i" : "", "bare LF must retain its column, so repaint erases the original character");
      assert.equal(line(4), "OUTPUT_DONE");
      assert.equal(line(5), "中文 😀");
    } finally { screen.dispose(); }
  }
});

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
