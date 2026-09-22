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

/** Directory that holds everything tide writes: the config file, delivery scripts and logs.
 * Override with the `TIDE_STATE_DIR` env var. Not overridable from config.json — that would
 * create a chicken-and-egg of "which stateDir does this very config file describe?". */
const STATE_DIR = process.env["TIDE_STATE_DIR"]
  ? resolve(process.env["TIDE_STATE_DIR"])
  : join(packageRoot(), ".tide");

const CONFIG_FILENAME = "config.json";

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

const RESUME_PROMPT = "继续刚才的任务。先检查当前状态和上次做到哪里，再继续执行。";

/** Runtime config: disk is the source of truth. Construct via `fromFile`, mutate via
 * `update`. Direct field assignment is forbidden at the type level (fields are `readonly`)
 * — there's no in-memory state outside of what the file says. */
export class Config {
  readonly dryRun: boolean = false;
  readonly skipQuotaCheck: boolean = false;
  readonly sessionAllowList: string[] = [];
  readonly sessionAll: boolean = false;
  readonly sessionDenyList: string[] = [];
  readonly watchPolicy: WatcherPolicy = {
    sweepIntervalMinutes: 3,
    idleMinutesBeforeResume: 5,
    skipSubagents: true,
    maxMainSessions: 50,
  };
  readonly resume: ResumePolicy = { prompt: RESUME_PROMPT };
  readonly codex: CodexConfig = {
    enabled: true,
    bin: "",
    deliveryTimeoutSeconds: 20,
  };
  readonly claude: ClaudeConfig = {
    enabled: true,
    bin: "",
    probeTimeoutSeconds: 30,
    probePrompt: "Respond with the single word: pong",
  };

  private constructor(data: Record<string, unknown> = {}) {
    // stateDir is env-only; discard any value supplied via input so stale entries in
    // existing config.json files can't shadow `TIDE_STATE_DIR`.
    const { stateDir: _envOnly, ...rest } = data;
    Object.assign(this, mergeConfig({ ...this }, rest));
  }

  /** Directory that holds everything tide writes. Override with `TIDE_STATE_DIR`. */
  get stateDir(): string {
    return STATE_DIR;
  }

  /** Full path of the config file. Always `<stateDir>/config.json`. */
  get path(): string {
    return join(this.stateDir, CONFIG_FILENAME);
  }

  /** Construct a Config from the canonical path. If the file is missing, write a defaults-only
   * copy and return a Config that reflects those defaults. If it exists, parse it and merge
   * its keys over the class defaults. Throws on read / write / parse failures. */
  static fromFile(persistDefaults = true): Config {
    const path = join(STATE_DIR, CONFIG_FILENAME);
    if (!existsSync(path)) {
      const fresh = new Config();
      if (!persistDefaults) return fresh;
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(serializeForDisk(fresh), null, 2) + "\n", "utf8");
      } catch (err) {
        throw new Error(`failed to write config file at ${path}: ${(err as Error).message}`);
      }
      return fresh;
    }
    return new Config(Config.#readFromDisk(path));
  }

  /** Apply `patch` (deep-merged over the current state) and persist. The file is the source
   * of truth, so after writing we re-read it: in-memory reflects whatever's actually on disk
   * — including any concurrent writes from other processes that landed between our merge and
   * our read. Returns `this`. */
  update(patch: Record<string, unknown>): Config {
    Object.assign(this, mergeConfig({ ...this }, patch));
    const path = this.path;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(serializeForDisk(this), null, 2) + "\n", "utf8");
    } catch (err) {
      throw new Error(`failed to write config file at ${path}: ${(err as Error).message}`);
    }
    // Re-read so in-memory === disk (any concurrent writes win for keys they touched).
    Object.assign(this, mergeConfig({ ...this }, Config.#readFromDisk(path)));
    return this;
  }

  /** Invocation options affect this process only. */
  withOverrides(patch: Record<string, unknown>): Config {
    return new Config(mergeConfig({ ...this }, patch) as Record<string, unknown>);
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
