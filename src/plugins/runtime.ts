import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { errorMessage, type SessionInfo, type Snapshot } from "../session/types.js";
// A plugin id is a CLI namespace, so the names it must avoid are the CLI's
// command names. help.ts imports nothing, so this direction adds no cycle.
import { isReservedName } from "../cli/help.js";
import { createCodexResume } from "./codex-resume/index.js";
import { createClaudeResume } from "./claude-code-resume/index.js";

export interface ObserveContext {
  session: Readonly<SessionInfo>;
  capture(lines?: number): Promise<Snapshot>;
}
export interface PluginContext extends ObserveContext {
  send(text: string): Promise<void>;
  sendKey(...keys: string[]): Promise<void>;
  onOutput(listener: () => void | Promise<void>): () => void;
}

// Context passed to a plugin's command.run. Commands run only inside a session
// host — the CLI resolves the namespace and routes, and never calls run itself —
// so the context is always bound to the session that was addressed. It is the
// same set of primitives start() gets, minus the output subscription.
export type PluginCommandContext = Omit<PluginContext, "onOutput">;

// A command a plugin registers. The CLI addresses it as
// `tide <plugin id> <command> <session id> [args...]` and forwards everything
// after the session id as args. `all` marks a command that is also meaningful
// for every session at once: `--all` then stands in for the session id, and the
// CLI runs the command in each session whose host reports a match.
export interface PluginCommand {
  description: string;
  all?: boolean;
  run(args: string[], context: PluginCommandContext): unknown | Promise<unknown>;
}

export interface TidePlugin {
  // Addressing id: unique across plugins, and the namespace in `tide <id> ...`.
  id: string;
  // Human-readable name, shown by `tide plugin list` and `tide <id> --help`.
  name: string;
  detect(context: ObserveContext): boolean | Promise<boolean>;
  commands?: Record<string, PluginCommand>;
  start?(context: PluginContext): void | (() => void) | Promise<void | (() => void)>;
}

// Bundled plugins, selectable by these names in plugins.json. The selector is
// only a configuration key; each plugin carries its own id and display name.
const BUNDLED: Record<string, () => TidePlugin> = { cxr: createCodexResume, ccr: createClaudeResume };
const PLUGIN_IDENTIFIER = /^[a-z][a-z0-9-]*$/;

export interface PluginSummary { id: string; name: string; source: string; enabled: boolean }

function validated(plugin: TidePlugin, source: string): TidePlugin {
  if (!plugin || !PLUGIN_IDENTIFIER.test(plugin.id) || typeof plugin.name !== "string" || !plugin.name.trim()
    || typeof plugin.detect !== "function" || (plugin.start !== undefined && typeof plugin.start !== "function")) throw Error(`Invalid Tide plugin: ${source}`);
  // A reserved id can never be addressed: the CLI dispatches core commands
  // first, so the plugin would load, run and answer plugin status while no
  // command could reach it. Every load passes through here — session start,
  // plugin list and plugin enable — so one check covers all of them.
  if (isReservedName(plugin.id)) throw Error(`Plugin ID collides with a core command: ${plugin.id} (${source}); rename the plugin or remove it from plugins.json`);
  for (const [name, command] of Object.entries(plugin.commands ?? {})) {
    if (!PLUGIN_IDENTIFIER.test(name) || typeof command.description !== "string" || typeof command.run !== "function"
      || (command.all !== undefined && typeof command.all !== "boolean")) throw Error(`Invalid command in ${plugin.id}: ${name}`);
  }
  return plugin;
}

// Reads plugins.json: `selectors` is the list as written, `config` keeps the rest
// of the file so a write-back cannot drop keys the core does not use.
function pluginConfig(file: string): { selectors: string[]; config: Record<string, unknown> } {
  if (!existsSync(file)) return { selectors: [], config: {} };
  const config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const selectors = config.plugins;
  if (!Array.isArray(selectors) || !selectors.every((p) => typeof p === "string")) throw Error(`${file}: plugins must be an array of bundled plugin names or explicit local module paths`);
  return { selectors: selectors as string[], config };
}

// Loads one selector: a bundled name, or a module path resolved against the
// configuration file's directory. Validation happens here, so every caller —
// session start, plugin list, plugin enable — applies the same rules.
async function loadSelector(file: string, selector: string): Promise<{ plugin: TidePlugin; source: string }> {
  const create = BUNDLED[selector];
  const path = resolve(dirname(file), selector);
  if (!create && !existsSync(path)) throw Error(`Unknown plugin: ${selector}; use a bundled name (${Object.keys(BUNDLED).join(", ")}) or an existing module path`);
  const plugin: TidePlugin = create ? create() : (await import(pathToFileURL(path).href)).default;
  return { plugin: validated(plugin, selector), source: create ? "bundled" : selector };
}

async function configured(file: string): Promise<Array<{ plugin: TidePlugin; source: string }>> {
  const loaded: Array<{ plugin: TidePlugin; source: string }> = [];
  const seenIds = new Set<string>();
  for (const selector of pluginConfig(file).selectors) {
    const entry = await loadSelector(file, selector);
    if (seenIds.has(entry.plugin.id)) throw Error(`Duplicate plugin ID: ${entry.plugin.id}`);
    seenIds.add(entry.plugin.id);
    loaded.push(entry);
  }
  return loaded;
}

export async function loadPlugins(state: string): Promise<TidePlugin[]> {
  return (await configured(join(state, "plugins.json"))).map(({ plugin }) => plugin);
}

// `tide plugin enable/disable`: the only core command that writes configuration.
// `selector` is exactly the string plugins.json stores — a bundled name or a
// module path resolved against the file's directory. Enabling loads the module
// and validates it first, so the file never gains a plugin that cannot load.
// A host loads its plugins at launch, so this affects sessions started later.
export async function setPluginEnabled(state: string, selector: string, enabled: boolean): Promise<string> {
  const file = join(state, "plugins.json");
  const { selectors, config } = pluginConfig(file);
  const present = selectors.includes(selector);
  if (enabled === present) throw Error(enabled ? `Plugin already enabled: ${selector}` : `Plugin not enabled: ${selector}`);
  if (enabled) {
    const candidate = await loadSelector(file, selector);
    if ((await configured(file)).some(({ plugin }) => plugin.id === candidate.plugin.id)) throw Error(`Duplicate plugin ID: ${candidate.plugin.id}`);
  }
  const next = enabled ? [...selectors, selector] : selectors.filter((entry) => entry !== selector);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...config, plugins: next }, null, 2)}\n`);
  return file;
}

// Registry view for `tide plugin list`: every plugin Tide can run, in
// configuration order, followed by bundled plugins that are switched off.
export async function pluginList(state: string): Promise<PluginSummary[]> {
  const on = await configured(join(state, "plugins.json"));
  const enabled = new Set(on.map(({ plugin }) => plugin.id));
  const off = Object.values(BUNDLED).map((create) => create()).filter((plugin) => !enabled.has(plugin.id));
  return [
    ...on.map(({ plugin, source }) => ({ id: plugin.id, name: plugin.name, source, enabled: true })),
    ...off.map((plugin) => ({ id: plugin.id, name: plugin.name, source: "bundled", enabled: false })),
  ];
}

export class Plugins {
  private readonly listeners = new Set<() => void | Promise<void>>();
  private readonly cleanup: Array<() => void | Promise<void>> = [];
  private readonly problems = new Map<string, string>();
  private active = true;
  constructor(private readonly plugins: TidePlugin[], private readonly base: Omit<PluginContext, "onOutput">) {}

  private observe(): ObserveContext { return { session: Object.freeze({ ...this.base.session }), capture: (lines) => this.base.capture(lines) }; }

  private assertActive(): void {
    if (!this.active || this.base.session.exited) throw Error("Session has ended");
  }

  private async assertMatches(plugin: TidePlugin, label: string): Promise<void> {
    if (!await plugin.detect(this.observe())) throw Error(`Plugin ${label} does not match this session`);
  }

  private context(plugin: TidePlugin): PluginContext {
    const check = async () => { this.assertActive(); await this.assertMatches(plugin, plugin.id); };
    return {
      ...this.observe(),
      send: async (text) => { await check(); await this.base.send(text); },
      sendKey: async (...keys) => { await check(); await this.base.sendKey(...keys); },
      onOutput: (listener) => {
        if (!this.active) throw Error("Session has ended");
        // A slow observer never accumulates concurrent executions of itself.
        let running = false;
        const guarded = async () => {
          if (running || !this.active) return;
          running = true;
          try { await listener(); } catch (error) { this.problems.set(plugin.id, errorMessage(error)); }
          finally { running = false; }
        };
        this.listeners.add(guarded);
        return () => this.listeners.delete(guarded);
      },
    };
  }

  async start() {
    for (const plugin of this.plugins) {
      try { const dispose = await plugin.start?.(this.context(plugin)); if (dispose) this.cleanup.push(dispose); }
      catch (error) { this.problems.set(plugin.id, errorMessage(error)); }
    }
  }
  outputChanged() { if (this.active) for (const listener of this.listeners) void listener(); }
  async list() {
    return Promise.all(this.plugins.map(async (plugin) => {
      try {
        const matched = !this.base.session.exited && await plugin.detect(this.observe());
        return { id: plugin.id, name: plugin.name, matched, commands: matched ? Object.entries(plugin.commands ?? {}).map(([name, value]) => ({ name, description: value.description })) : [], error: this.problems.get(plugin.id) ?? null };
      } catch (error) { return { id: plugin.id, name: plugin.name, matched: false, commands: [], error: errorMessage(error) }; }
    }));
  }
  async run(id: string, command: string, args: string[]) {
    const plugin = this.plugins.find((p) => p.id === id);
    if (!plugin) throw Error(`Plugin not configured: ${id}`);
    await this.assertMatches(plugin, id);
    if (!Object.hasOwn(plugin.commands ?? {}, command)) throw Error(`Unknown plugin command: ${id}/${command}`);
    const context: PluginCommandContext = {
      ...this.base,
      send: async (text) => { this.assertActive(); await this.base.send(text); },
      sendKey: async (...keys) => { this.assertActive(); await this.base.sendKey(...keys); },
    };
    return plugin.commands![command]!.run(args, context);
  }
  async dispose() {
    if (!this.active) return;
    this.active = false; this.listeners.clear();
    await Promise.allSettled(this.cleanup.map((dispose) => Promise.resolve().then(dispose)));
  }
}