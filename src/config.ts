import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type CliKind = "codex" | "claude";

export interface FilterPolicy {
  minIdleMinutes: number;
  maxAgeMinutes: number | null;
  skipSubagents: boolean;
}

export interface ResumePolicy {
  prompt: string;
}

export interface CodexConfig {
  enabled: boolean;
  bin: string;
  deliveryTimeoutSeconds: number;
}

export interface Config {
  stateDir: string;
  debug: boolean;
  dryRun: boolean;
  /** When true, the watcher skips the quota probe and resumes any waiting session. Test/debug only. */
  skipQuotaCheck: boolean;
  filter: FilterPolicy;
  resume: ResumePolicy;
  codex: CodexConfig;
}

function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (let dir = here; ; ) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return here;
    dir = parent;
  }
}

export function defaultStateDir(): string {
  const override = process.env["TIDE_STATE_DIR"];
  return override ? resolve(override) : join(packageRoot(), ".tide");
}

const RESUME_PROMPT = "继续刚才的任务。先检查当前状态和上次做到哪里，再继续执行。";

export function defaultConfig(): Config {
  return {
    stateDir: defaultStateDir(),
    debug: false,
    dryRun: false,
    skipQuotaCheck: false,
    filter: {
      minIdleMinutes: 5,
      maxAgeMinutes: 24 * 60,
      skipSubagents: true,
    },
    resume: {
      prompt: RESUME_PROMPT,
    },
    codex: {
      enabled: true,
      bin: "",
      deliveryTimeoutSeconds: 20,
    },
  };
}

function merge(base: Config, patch: DeepPartial<Config>): Config {
  const out = { ...base } as Record<string, unknown>;
  const source = base as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = source[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value) && typeof current === "object") {
      out[key] = { ...(current as object), ...(value as object) };
    } else {
      out[key] = value;
    }
  }
  return out as unknown as Config;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

export function configPathFor(explicitPath?: string): string {
  if (explicitPath) return resolve(explicitPath);
  const fromEnv = process.env["TIDE_CONFIG"];
  return fromEnv ? resolve(fromEnv) : join(defaultStateDir(), "config.json");
}

export function loadConfig(explicitPath?: string): { config: Config; path: string | null } {
  const path = configPathFor(explicitPath);

  if (!existsSync(path)) {
    if (explicitPath || process.env["TIDE_CONFIG"]) {
      throw new Error(`no config file at ${path}`);
    }
    return { config: defaultConfig(), path: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`config at ${path} must be a JSON object`);
  }
  const config = merge(defaultConfig(), parsed as DeepPartial<Config>);
  if (!Number.isFinite(config.codex.deliveryTimeoutSeconds) || config.codex.deliveryTimeoutSeconds <= 0) {
    throw new Error("codex.deliveryTimeoutSeconds must be a positive number");
  }
  return { config, path };
}
