import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { stateDirectory } from "../../src/session/registry.ts";
import { displayEndpoint, listenEndpoint, sessionEndpoint, validateEndpoint } from "../../src/session/endpoints.ts";
import { MIN_BASH_VERSION, requireBashVersion, checkBash } from "../../src/terminal/shell.ts";

test("state directory defaults to the user home, with an explicit override", () => {
  const old = process.env.TIDE_STATE_DIR;
  try {
    delete process.env.TIDE_STATE_DIR;
    assert.equal(stateDirectory(), join(homedir(), ".tide"));
    process.env.TIDE_STATE_DIR = "custom-state";
    assert.equal(stateDirectory(), resolve("custom-state"));
  } finally { if (old === undefined) delete process.env.TIDE_STATE_DIR; else process.env.TIDE_STATE_DIR = old; }
});

test("Bash 4.4 is the inclusive minimum; unsupported and unknown versions fail clearly", () => {
  assert.equal(MIN_BASH_VERSION, "4.4");
  for (const version of ["4.4", "4.4.0(1)-release", "4.10.0", "5.3.15(1)-release", "10.0.0"]) requireBashVersion("bash", version);
  for (const version of ["3.2.57(1)-release", "4.3.48", "4.0", "", "zsh 5.9"]) {
    assert.throws(() => requireBashVersion("/chosen/bash", version), /requires Bash >= 4\.4.*\/chosen\/bash.*--shell/);
  }
  assert.throws(() => checkBash("tide-missing-bash-executable"), /Cannot verify Bash >= 4\.4/);
});

test("socket limit counts bytes and includes the display suffix; pipes have no Unix limit", () => {
  validateEndpoint("a".repeat(103), "darwin");
  assert.throws(() => validateEndpoint("a".repeat(104), "darwin"), /TIDE_STATE_DIR/);
  assert.throws(() => validateEndpoint("界".repeat(35), "darwin"), /105 bytes/);
  assert.throws(() => validateEndpoint(displayEndpoint({ endpoint: "a".repeat(100) }), "darwin"), /too long/);
  validateEndpoint("a".repeat(200), "win32");
});

test("session transport is private, unique, scoped to state and disposable", () => {
  const state = mkdtempSync(join(tmpdir(), "ts-"));
  const first = sessionEndpoint(state, randomUUID()), second = sessionEndpoint(state, randomUUID());
  try {
    assert.notEqual(first.endpoint, second.endpoint);
    if (process.platform === "win32") assert.match(first.endpoint, /^\\\\\.\\pipe\\tide-/);
    else {
      assert(first.endpoint.startsWith(join(state, "sockets") + "/"));
      assert.equal(statSync(join(state, "sockets")).mode & 0o777, 0o700);
    }
  } finally { first.dispose(); second.dispose(); rmSync(state, { recursive: true, force: true }); }
});

test("long state paths are rejected before creating directories", { skip: process.platform === "win32" }, () => {
  const state = join(tmpdir(), "tide-" + "x".repeat(110));
  assert.throws(() => sessionEndpoint(state, randomUUID()), /too long/);
  assert.equal(existsSync(state), false);
});

test("socket root rejects symlinks", { skip: process.platform === "win32" }, () => {
  const state = mkdtempSync(join(tmpdir(), "ts-")), target = mkdtempSync(join(tmpdir(), "tt-"));
  try {
    symlinkSync(target, join(state, "sockets"));
    assert.throws(() => sessionEndpoint(state, randomUUID()), /Unsafe Tide directory/);
  } finally { rmSync(state, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});

test("listen permission failure closes the server; failed bind preserves another listener", { skip: process.platform === "win32" }, async () => {
  const state = mkdtempSync(join(tmpdir(), "ts-")), transport = sessionEndpoint(state, randomUUID());
  const server = createServer(), other = createServer();
  try {
    server.once("listening", () => unlinkSync(transport.endpoint));
    await assert.rejects(listenEndpoint(server, transport.endpoint), /ENOENT/);
    assert.equal(server.listening, false);
    await listenEndpoint(server, transport.endpoint);
    assert.equal(statSync(transport.endpoint).mode & 0o777, 0o600);
    await assert.rejects(listenEndpoint(other, transport.endpoint), /EADDRINUSE/);
    assert.equal(existsSync(transport.endpoint), true);
    assert.equal(server.listening, true);
  } finally {
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
    if (other.listening) await new Promise<void>(done => other.close(() => done()));
    transport.dispose(); rmSync(state, { recursive: true, force: true });
  }
});
