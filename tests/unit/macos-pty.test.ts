import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureExecutableHelper, prepareMacPty } from "../../src/terminal/macos-pty.ts";

test("non-macOS startup does not resolve or modify a helper", () => {
  for (const platform of ["win32", "linux"] as const) {
    prepareMacPty(platform, () => { throw Error("must not resolve"); });
  }
});

test("helper lookup failure is actionable", () => {
  assert.throws(() => prepareMacPty("darwin", () => { throw Error("native module missing"); }), /Cannot locate.*Reinstall node-pty/);
});

test("missing helper is not created, and directories are not chmodded", () => {
  const directory = mkdtempSync(join(tmpdir(), "tide-helper-"));
  const helper = join(directory, "spawn-helper");
  try {
    assert.throws(() => ensureExecutableHelper(helper), /spawn-helper.*ENOENT.*Reinstall/);
    assert.equal(existsSync(helper), false);
    assert.throws(() => ensureExecutableHelper(directory), /expected a regular file/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("macOS preparation adds only owner execute and is idempotent", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "tide-helper-"));
  const helper = join(directory, "spawn-helper"), unrelated = join(directory, "other");
  try {
    writeFileSync(helper, "#!/bin/sh\nexit 0\n");
    writeFileSync(unrelated, "other"); chmodSync(unrelated, 0o640);
    for (const mode of [0o644, 0o640, 0o600]) {
      chmodSync(helper, mode);
      prepareMacPty("darwin", () => helper);
      assert.equal(statSync(helper).mode & 0o777, mode | 0o100);
      const before = statSync(helper);
      prepareMacPty("darwin", () => helper);
      assert.equal(statSync(helper).ctimeMs, before.ctimeMs, "already executable files must not be changed");
    }
    chmodSync(helper, 0o755);
    const before = statSync(helper);
    ensureExecutableHelper(helper);
    assert.equal(statSync(helper).mode & 0o777, 0o755);
    assert.equal(statSync(helper).ctimeMs, before.ctimeMs);
    assert.equal(statSync(unrelated).mode & 0o777, 0o640);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("helper symlinks are rejected without changing their target", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "tide-helper-"));
  const target = join(directory, "target"), helper = join(directory, "spawn-helper");
  try {
    writeFileSync(target, "target"); chmodSync(target, 0o640);
    symlinkSync(target, helper);
    assert.throws(() => ensureExecutableHelper(helper), /not a directory or symlink/);
    assert.equal(statSync(target).mode & 0o777, 0o640);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
