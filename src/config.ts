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

/** Default cap on the session list that status and watch trim the adapter's result to. */
export const MAX_SESSIONS_RETURNED = 100;

/** Skip rollout / transcript files whose mtime is older than this. */
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
  /** Session ids that `claude --bg --resume` has already nudged. */
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
  return v !== null && typeof v === "object" && !Array.isArray(v);
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

function mergeValue(current: unknown, value: unknown): unknown {
  return isPlainObject(value) && isPlainObject(current)
    ? { ...current, ...value }
    : value;
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
        fields[key] = mergeValue(fields[key], (data as Record<string, unknown>)[key]);
      }
    }
    this.claude.resumedSessions = cleanIds(this.claude.resumedSessions);
    if (path !== undefined) this.#path = path;
  }

  toJSON(): object {
    const data = {
      ...this,
      claude: {
        ...this.claude,
        resumedSessions: [...this.claude.resumedSessions],
      },
    };
    return data;
  }

  get path(): string {
    return this.#path;
  }

  /** Persist current in-memory state to the file load() read from. */
  flush(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      writeFileSync(this.#path, JSON.stringify(this, null, 2) + "\n", "utf8");
    } catch (err) {
      console.error(`Failed to write config file to ${this.#path}: ${(err as Error).message}`);
    }
  }

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
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`config at ${this.#path} must be a JSON object`);
    }

    Object.assign(this, new Config(parsed as object, this.#path));
    return this;
  }
}
