import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type CliKind = "codex" | "claude";

export interface WatcherPolicy {
  /** How long the watcher waits between sweeps, in minutes. */
  sweepIntervalMinutes: number;
  /** A session must have been quiet for at least this long, in minutes, before the watcher resumes it. */
  idleMinutesBeforeResume: number;
  /** Skip subagent forks; only resume parent (top-level) sessions. */
  skipSubagents: boolean;
  /** Reserved slots for top-level sessions before subagent forks fill the rest. */
  maxMainSessions: number;
}

export const MAX_SESSIONS_RETURNED = 100;
export const SCAN_MTIME_CUTOFF_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_CONFIG_PATH = "./.tide/config.json";

export interface ResumePolicy {
  prompt: string;
}

export interface CodexConfig {
  enabled: boolean;
  bin: string;
  deliveryTimeoutSeconds: number;
}

export interface ClaudeConfig {
  enabled: boolean;
  bin: string;
  probeTimeoutSeconds: number;
  probePrompt: string;
}

function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (let dir = here; ; ) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return here;
    }
    dir = parent;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return false;
  }
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Deep-merge `patch` over `current`. Non-object values (including missing) replace `current`. */
function mergeConfig(current: unknown, patch: unknown): unknown {
  if (!isPlainObject(current) || !isPlainObject(patch)) {
    return patch;
  }
  const out: Record<string, unknown> = { ...current };
  for (const key of Object.keys(patch)) {
    out[key] = mergeConfig(out[key], patch[key]);
  }
  return out;
}

/** JSON form of a runtime value: Sets become arrays, other objects recurse over own keys. */
function serializeForDisk(value: unknown): unknown {
  if (value instanceof Set) return [...value].map(serializeForDisk);
  if (Array.isArray(value)) return value.map(serializeForDisk);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = serializeForDisk((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const STATE_DIR = process.env["TIDE_STATE_DIR"]
  ? resolve(process.env["TIDE_STATE_DIR"])
  : join(packageRoot(), ".tide");


const RESUME_PROMPT = "继续刚才的任务。先检查当前状态和上次做到哪里，再继续执行。";

/** Runtime config: defaults on every field, plus the file the config was loaded from. */
export class Config {
  stateDir: string = STATE_DIR;
  dryRun: boolean = false;
  skipQuotaCheck: boolean = false;
  sessionAllowList: string[] = [];
  sessionAll: boolean = false;
  /** Session ids — or id prefixes, matched by `startsWith` — the watcher must never touch.
   * Deny beats `sessionAllowList` and `sessionAll`. */
  sessionDenyList: string[] = [];
  watchPolicy: WatcherPolicy = {
    sweepIntervalMinutes: 3,
    idleMinutesBeforeResume: 5,
    skipSubagents: true,
    maxMainSessions: 50,
  };
  resume: ResumePolicy = { prompt: RESUME_PROMPT };
  codex: CodexConfig = {
    enabled: true,
    bin: "",
    deliveryTimeoutSeconds: 20,
  };
  claude: ClaudeConfig = {
    enabled: true,
    bin: "",
    probeTimeoutSeconds: 30,
    probePrompt: "Respond with the single word: pong",
  };

  #path: string = DEFAULT_CONFIG_PATH;

  constructor(data: Record<string, unknown> = {}, path?: string) {
    const result = mergeConfig({ ...this }, data);
    Object.assign(this, result);
    if (path !== undefined) this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  /** Construct a Config from `path`. If the file is missing, write a defaults-only copy and
   * return a Config that reflects those defaults. If it exists, parse it and merge its keys
   * over the class defaults. Throws on read / write / parse failures. */
  static fromFile(path: string): Config {
    if (!existsSync(path)) {
      const fresh = new Config({}, path);
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(serializeForDisk(fresh), null, 2) + "\n", "utf8");
      } catch (err) {
        throw new Error(`failed to write config file at ${path}: ${(err as Error).message}`);
      }
      return fresh;
    }
    return new Config(Config.#readFromDisk(path), path);
  }

  /** Re-read the file and deep-merge its keys onto this. Throws on parse errors or non-object
   * roots; never writes. Used by the watcher to pick up edits the user made between sweeps. */
  reload(): Config {
    const result = mergeConfig({ ...this }, Config.#readFromDisk(this.#path));
    Object.assign(this, result);
    return this;
  }

  /** Write the current in-memory state to the file it was loaded from. Throws on failure. */
  save(): void {
    const disk = serializeForDisk(this);
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      writeFileSync(this.#path, JSON.stringify(disk, null, 2) + "\n", "utf8");
    } catch (err) {
      throw new Error(`failed to write config file at ${this.#path}: ${(err as Error).message}`);
    }
  }

  static #readFromDisk(path: string): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(`config at ${path} is not valid JSON: ${(err as Error).message}`);
    }
    if (!isPlainObject(parsed)) {
      throw new Error(`config at ${path} must be a JSON object`);
    }
    return parsed;
  }
}
