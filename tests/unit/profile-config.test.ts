import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLaunchShellCommand, findProfile, loadProfiles, resolveProfilePath, tokenizeCommand } from "../../src/profile-config/index.ts";

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "tide-profile-config-"));
}

test("resolveProfilePath defaults to stateDir/launch-profiles.json and accepts TIDE_LAUNCH_PROFILES", () => {
  const state = tempStateDir();
  try {
    assert.equal(resolveProfilePath(state, {}), join(state, "launch-profiles.json"));
    assert.equal(resolveProfilePath(state, { TIDE_LAUNCH_PROFILES: "/etc/x.json" }), "/etc/x.json");
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("loadProfiles reads, validates, requires non-empty commands, and reports a useful error when missing", () => {
  const state = tempStateDir();
  try {
    assert.throws(() => loadProfiles(state, {}), /Profile config not found/);
    const file = join(state, "launch-profiles.json");
    mkdirSync(state, { recursive: true });
    writeFileSync(file, JSON.stringify({
      profiles: [
        { label: "minimax", description: "MiniMAX", env: { ANTHROPIC_BASE_URL: "https://x", ANTHROPIC_AUTH_TOKEN: "tok" }, commands: ["claude"] },
        { label: "codex-default", env: {}, commands: ["codex --yolo"] },
        { label: "multi", env: {}, commands: ["echo step1", "echo step2"] },
      ],
    }));
    const loaded = loadProfiles(state, {});
    assert.equal(loaded.path, file);
    assert.deepEqual(loaded.profiles.map((p) => ({ label: p.label, commands: p.commands, env: p.env })), [
      { label: "minimax", commands: [["claude"]], env: { ANTHROPIC_BASE_URL: "https://x", ANTHROPIC_AUTH_TOKEN: "tok" } },
      { label: "codex-default", commands: [["codex", "--yolo"]], env: {} },
      { label: "multi", commands: [["echo", "step1"], ["echo", "step2"]], env: {} },
    ]);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("loadProfiles rejects missing or empty commands and non-array commands", () => {
  const state = tempStateDir();
  try {
    const file = join(state, "launch-profiles.json");
    mkdirSync(state, { recursive: true });
    writeFileSync(file, JSON.stringify({ profiles: [{ label: "minimax", env: {} }] }));
    assert.throws(() => loadProfiles(state, {}), /needs a non-empty "commands"/);
    writeFileSync(file, JSON.stringify({ profiles: [{ label: "minimax", env: {}, commands: [] }] }));
    assert.throws(() => loadProfiles(state, {}), /needs a non-empty "commands"/);
    writeFileSync(file, JSON.stringify({ profiles: [{ label: "minimax", env: {}, commands: ["claude", 42] }] }));
    assert.throws(() => loadProfiles(state, {}), /needs a non-empty "commands"/);
    writeFileSync(file, JSON.stringify({ profiles: [{ label: "minimax", env: {}, commands: ["   "] }] }));
    assert.throws(() => loadProfiles(state, {}), /commands\[0\] is empty after parsing/);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("tokenizeCommand handles whitespace, single, and double quotes", () => {
  assert.deepEqual(tokenizeCommand("claude --dangerously-skip-permissions"), ["claude", "--dangerously-skip-permissions"]);
  assert.deepEqual(tokenizeCommand("  codex -c 'foo bar'  "), ["codex", "-c", "foo bar"]);
  assert.deepEqual(tokenizeCommand(`codex -c "a b" --extra`), ["codex", "-c", "a b", "--extra"]);
  assert.deepEqual(tokenizeCommand(""), []);
  assert.deepEqual(tokenizeCommand("   "), []);
  assert.deepEqual(tokenizeCommand(`mix "a 'b' c" end`), ["mix", "a 'b' c", "end"]);
});

test("loadProfiles rejects bad labels, duplicates, non-string env values, and missing profiles array", () => {
  const state = tempStateDir();
  try {
    const file = join(state, "launch-profiles.json");
    mkdirSync(state, { recursive: true });
    writeFileSync(file, JSON.stringify({ profiles: [{ label: "Bad Label", env: {}, commands: ["claude"] }] }));
    assert.throws(() => loadProfiles(state, {}), /invalid label/);
    writeFileSync(file, JSON.stringify({ profiles: [{ label: "minimax", env: { ANTHROPIC_AUTH_TOKEN: 1 }, commands: ["claude"] }] }));
    assert.throws(() => loadProfiles(state, {}), /env\.ANTHROPIC_AUTH_TOKEN must be a string/);
    writeFileSync(file, JSON.stringify({ profiles: [{ label: "minimax", env: {}, commands: ["claude"] }, { label: "MINIMAX", env: {}, commands: ["claude"] }] }));
    assert.throws(() => loadProfiles(state, {}), /duplicated/);
    writeFileSync(file, JSON.stringify({}));
    assert.throws(() => loadProfiles(state, {}), /must be \{ "profiles": \[\.\.\.\] \}/);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("findProfile is case-insensitive and rejects malformed labels", () => {
  const profiles = [
    { index: 1, label: "minimax", description: "", env: {}, commands: [["claude"]] },
    { index: 2, label: "deepseek-flash", description: "", env: {}, commands: [["claude"]] },
  ];
  assert.equal(findProfile(profiles, "minimax")?.label, "minimax");
  assert.equal(findProfile(profiles, "MINIMAX")?.label, "minimax");
  assert.equal(findProfile(profiles, "DeepSeek-Flash")?.label, "deepseek-flash");
  assert.equal(findProfile(profiles, "missing"), null);
  assert.equal(findProfile(profiles, "Has Space"), null);
});

test("buildLaunchShellCommand unsets every key across the profile set, then exports only the chosen profile", () => {
  const profiles = [
    { index: 1, label: "minimax", description: "", env: { ANTHROPIC_BASE_URL: "https://minimax", ANTHROPIC_AUTH_TOKEN: "tok" }, commands: [["claude"]] },
    { index: 2, label: "codex", description: "", env: { OPENAI_API_KEY: "k" }, commands: [["codex"]] },
  ];
  const cmd = buildLaunchShellCommand(profiles[0]!, profiles);
  assert.equal(cmd, "unset ANTHROPIC_BASE_URL; unset ANTHROPIC_AUTH_TOKEN; unset OPENAI_API_KEY; export ANTHROPIC_BASE_URL='https://minimax'; export ANTHROPIC_AUTH_TOKEN='tok'; claude");
});

test("buildLaunchShellCommand runs multiple commands in order, joining with ';'", () => {
  const profile = { index: 1, label: "minimax", description: "", env: { K: "v" }, commands: [["echo", "step1"], ["echo", "step2"], ["claude"]] };
  const all = [profile];
  const cmd = buildLaunchShellCommand(profile, all);
  assert.equal(cmd, "unset K; export K='v'; echo step1; echo step2; claude");
});

test("buildLaunchShellCommand appends cwd and extra args to the LAST command, quoting values that need it", () => {
  const profile = { index: 1, label: "minimax", description: "", env: { K: "v with space" }, commands: [["echo", "ready"], ["claude", "--foo"]] };
  const all = [profile];
  const cmd = buildLaunchShellCommand(profile, all, ["--bar", "baz"], "/d/foo bar");
  assert.equal(cmd, "unset K; export K='v with space'; cd '/d/foo bar'; echo ready; claude --foo --bar baz");
});