import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { errorMessage, type SessionInfo, type Snapshot } from "./types.js";

export interface ObserveContext {
  session: Readonly<SessionInfo>;
  capture(lines?: number): Promise<Snapshot>;
}
export interface PluginContext extends ObserveContext {
  send(text: string): Promise<void>;
  sendKey(...keys: string[]): Promise<void>;
  onOutput(listener: () => void | Promise<void>): () => void;
}
export interface TidePlugin {
  id: string;
  detect(context: ObserveContext): boolean | Promise<boolean>;
  commands?: Record<string, { description: string; run(context: PluginContext, args: string[]): unknown | Promise<unknown> }>;
  start?(context: PluginContext): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

export async function loadPlugins(state: string): Promise<TidePlugin[]> {
  const file = join(state, "plugins.json");
  if (!existsSync(file)) return [];
  const config = JSON.parse(readFileSync(file, "utf8")) as { plugins?: unknown };
  if (!Array.isArray(config.plugins) || !config.plugins.every((p) => typeof p === "string")) throw Error(`${file}: plugins must be an array of explicit local module paths`);
  const plugins: TidePlugin[] = [];
  for (const path of config.plugins as string[]) {
    const module = await import(pathToFileURL(isAbsolute(path) ? path : resolve(dirname(file), path)).href);
    const plugin = module.default as TidePlugin;
    if (!plugin || !/^[a-z][a-z0-9-]*$/.test(plugin.id) || typeof plugin.detect !== "function" || (plugin.start !== undefined && typeof plugin.start !== "function")) throw Error(`Invalid Tide plugin: ${path}`);
    if (plugins.some((p) => p.id === plugin.id)) throw Error(`Duplicate plugin ID: ${plugin.id}`);
    for (const [name, command] of Object.entries(plugin.commands ?? {})) {
      if (!/^[a-z][a-z0-9-]*$/.test(name) || typeof command.description !== "string" || typeof command.run !== "function") throw Error(`Invalid command in ${plugin.id}: ${name}`);
    }
    plugins.push(plugin);
  }
  return plugins;
}

export class Plugins {
  private readonly listeners = new Set<() => void | Promise<void>>();
  private readonly cleanup: Array<() => void | Promise<void>> = [];
  private readonly problems = new Map<string, string>();
  private active = true;
  constructor(private readonly plugins: TidePlugin[], private readonly base: Omit<PluginContext, "onOutput">) {}

  private observe(): ObserveContext { return { session: Object.freeze({ ...this.base.session }), capture: (lines) => this.base.capture(lines) }; }

  private context(plugin: TidePlugin): PluginContext {
    const check = async () => {
      if (!this.active || this.base.session.exited) throw Error("Session has ended");
      if (!await plugin.detect(this.observe())) throw Error(`Plugin ${plugin.id} does not match this session`);
    };
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
        return { id: plugin.id, matched, commands: matched ? Object.entries(plugin.commands ?? {}).map(([name, value]) => ({ name, description: value.description })) : [], error: this.problems.get(plugin.id) ?? null };
      } catch (error) { return { id: plugin.id, matched: false, commands: [], error: errorMessage(error) }; }
    }));
  }
  async run(id: string, command: string, args: string[]) {
    const plugin = this.plugins.find((p) => p.id === id);
    if (!plugin) throw Error(`Plugin not configured: ${id}`);
    if (!await plugin.detect(this.observe())) throw Error(`Plugin ${id} does not match this session`);
    if (!Object.hasOwn(plugin.commands ?? {}, command)) throw Error(`Unknown plugin command: ${id}/${command}`);
    return plugin.commands![command]!.run(this.context(plugin), args);
  }
  async dispose() {
    if (!this.active) return;
    this.active = false; this.listeners.clear();
    await Promise.allSettled(this.cleanup.map((dispose) => Promise.resolve().then(dispose)));
  }
}
