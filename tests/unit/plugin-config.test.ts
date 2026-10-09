import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadPlugins, pluginList, setPluginEnabled } from "../../src/plugins/runtime.ts";

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "tide-plugin-config-"));
}

function written(state: string): { plugins: string[]; note?: string } {
  return JSON.parse(readFileSync(join(state, "plugins.json"), "utf8")) as { plugins: string[]; note?: string };
}

function moduleFile(state: string, name: string, source: string): string {
  const path = join(state, name);
  writeFileSync(path, source);
  return path;
}

function cli(state: string, ...args: string[]) {
  return spawnSync(process.execPath, [resolve("dist/tide.mjs"), ...args], {
    encoding: "utf8", windowsHide: true, timeout: 15000,
    env: { ...process.env, TIDE_STATE_DIR: state },
  });
}

test("setPluginEnabled creates plugins.json and keeps keys the core does not use", async () => {
  const state = tempStateDir();
  try {
    moduleFile(state, "first.mjs", 'export default { id: "first", name: "First", detect: () => true };');
    moduleFile(state, "second.mjs", 'export default { id: "second", name: "Second", detect: () => true };');
    assert.equal(await setPluginEnabled(state, "./first.mjs", true), join(state, "plugins.json"));
    assert.deepEqual(written(state), { plugins: ["./first.mjs"] });
    writeFileSync(join(state, "plugins.json"), JSON.stringify({ plugins: ["./first.mjs"], note: "keep" }));
    await setPluginEnabled(state, "./second.mjs", true);
    assert.deepEqual(written(state), { plugins: ["./first.mjs", "./second.mjs"], note: "keep" });
    await setPluginEnabled(state, "./first.mjs", false);
    assert.deepEqual(written(state), { plugins: ["./second.mjs"], note: "keep" });
    assert.deepEqual((await pluginList(state)).map((entry) => `${entry.id}:${entry.enabled}`), ["second:true"]);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("setPluginEnabled validates the candidate before writing", async () => {
  const state = tempStateDir();
  try {
    moduleFile(state, "first.mjs", 'export default { id: "first", name: "First", detect: () => true };');
    await assert.rejects(setPluginEnabled(state, "nope", true), /Unknown plugin: nope/);
    await assert.rejects(setPluginEnabled(state, "./first.mjs", false), /Plugin not enabled/);
    await setPluginEnabled(state, "./first.mjs", true);
    await assert.rejects(setPluginEnabled(state, "./first.mjs", true), /already enabled/);
    // A module that cannot load, or whose id collides with a core command, is
    // rejected without reaching the file.
    const broken = moduleFile(state, "broken.mjs", "export default {}\n");
    await assert.rejects(setPluginEnabled(state, broken, true), /Invalid Tide plugin/);
    const shadow = moduleFile(state, "shadow.mjs", "export default { id: \"send\", name: \"Shadow\", detect: () => true, commands: {} };\n");
    await assert.rejects(setPluginEnabled(state, shadow, true), /collides with a core command: send/);
    assert.deepEqual(written(state).plugins, ["./first.mjs"]);
    // A valid module is accepted; a second module claiming the same id is not.
    const ok = moduleFile(state, "ok.mjs", "export default { id: \"ok\", name: \"Ok\", detect: () => true, commands: {} };\n");
    await setPluginEnabled(state, ok, true);
    const twin = moduleFile(state, "ok2.mjs", "export default { id: \"ok\", name: \"Twin\", detect: () => true, commands: {} };\n");
    await assert.rejects(setPluginEnabled(state, twin, true), /Duplicate plugin ID: ok/);
    assert.deepEqual(written(state).plugins, ["./first.mjs", ok]);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("a colliding plugin id fails the load session start performs", async () => {
  const state = tempStateDir();
  try {
    const shadow = moduleFile(state, "shadow.mjs", "export default { id: \"send\", name: \"Shadow\", detect: () => true, commands: {} };\n");
    writeFileSync(join(state, "plugins.json"), JSON.stringify({ plugins: [shadow] }));
    await assert.rejects(loadPlugins(state), /collides with a core command: send/);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("plugin list fails on a collision and disable still removes the entry", () => {
  const state = tempStateDir();
  try {
    const shadow = moduleFile(state, "shadow.mjs", "export default { id: \"send\", name: \"Shadow\", detect: () => true, commands: {} };\n");
    writeFileSync(join(state, "plugins.json"), JSON.stringify({ plugins: [shadow] }));
    const shadowed = cli(state, "plugin", "list");
    assert.equal(shadowed.status, 1, shadowed.stdout);
    assert.match(shadowed.stderr, /collides with a core command: send/);
    // Disabling does not load the module, so a broken entry can always be removed.
    const disabled = cli(state, "plugin", "disable", shadow);
    assert.equal(disabled.status, 0, disabled.stderr);
    const listed = cli(state, "plugin", "list");
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).map((entry: { id: string }) => entry.id), []);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("empty configuration has no bundled catalog; retired selectors fail without rewriting config", async () => {
  const state = tempStateDir();
  try {
    assert.deepEqual(await pluginList(state), []);
    assert.deepEqual(await loadPlugins(state), []);
    writeFileSync(join(state, "plugins.json"), JSON.stringify({ plugins: ["ccr", "cxr"], note: "keep" }));
    const before = readFileSync(join(state, "plugins.json"), "utf8");
    await assert.rejects(loadPlugins(state), /Former built-ins.*docs\/resume-plugins.md/);
    assert.equal(readFileSync(join(state, "plugins.json"), "utf8"), before);
    await setPluginEnabled(state, "ccr", false);
    await setPluginEnabled(state, "cxr", false);
    assert.deepEqual(written(state), { plugins: [], note: "keep" });
    assert.deepEqual(await pluginList(state), []);
  } finally { rmSync(state, { recursive: true, force: true }); }
});
