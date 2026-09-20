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
  deliveryTimeoutSeconds: number;
  probeTimeoutSeconds: number;
  probePrompt: string;
  resumedSessions: Set<string>;
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

function cleanIds(raw: unknown): Set<string> {
  if (raw == null || typeof (raw as Iterable<unknown>)[Symbol.iterator] !== "function") {
    return new Set<string>();
  }
  const out = new Set<string>();
  for (const item of raw as Iterable<unknown>) {
    if (typeof item === "string" && item.length > 0) {
      out.add(item);
    }
  }
  return out;
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
    deliveryTimeoutSeconds: 20,
    probeTimeoutSeconds: 30,
    probePrompt: "Respond with the single word: pong",
    resumedSessions: new Set<string>(),
  };

  #path: string = "./.tide/config.json";

  constructor(data: object = {}, path?: string) {
    const fields = this as unknown as Record<string, unknown>;
    for (const key of Object.keys(data)) {
      if (key in fields) {
        fields[key] = mergeConfig(fields[key], (data as Record<string, unknown>)[key]);
      }
    }
    this.claude.resumedSessions = cleanIds(this.claude.resumedSessions);
    if (path !== undefined) this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  /** Persist `patch` onto the file it was loaded from. The file is re-read first and only the
   * patch is merged in, so concurrent edits to other fields survive. A missing file is
   * bootstrapped from the full in-memory state. */
  flush(patch: object): void {
    const filePath = this.#path;
    let disk: Record<string, unknown>;
    if (existsSync(filePath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
        if (!isPlainObject(parsed)) {
          console.error(`config at ${filePath} is not a JSON object; skipping flush`);
          return;
        }
        disk = mergeConfig(parsed, serializeForDisk(patch)) as Record<string, unknown>;
      } catch (err) {
        console.error(`Failed to read config file from ${filePath}: ${(err as Error).message}`);
        return;
      }
    } else {
      disk = serializeForDisk(this) as Record<string, unknown>;
    }
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(disk, null, 2) + "\n", "utf8");
    } catch (err) {
      console.error(`Failed to write config file to ${filePath}: ${(err as Error).message}`);
    }
  }

  /** Re-read the file into in-memory state. */
  load(): Config {
    if (!existsSync(this.#path)) {
      return this;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#path, "utf8"));
    } catch (err) {
      throw new Error(`config at ${this.#path} is not valid JSON: ${(err as Error).message}`);
    }
    if (!isPlainObject(parsed)) {
      throw new Error(`config at ${this.#path} must be a JSON object`);
    }

    Object.assign(this, new Config(parsed, this.#path));
    return this;
  }
}
