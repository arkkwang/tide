/**
 * The one directory this program may write: its boundary, policy, memory and journal.
 * The CLIs' own directories are not ours; see `isProtected`.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type CliKind = "codex" | "claude";

// ── the boundary ────────────────────────────────────────────────────────────────────────

/**
 * Codex's and Claude Code's own state: read-only to us, always. Enforced centrally rather
 * than at each call site, where a convenience write would look perfectly reasonable.
 */
function protectedRoots(): string[] {
  const home = homedir();
  const roots = [
    join(home, ".claude"),
    join(home, ".codex"),
    join(home, ".claude.json"),
  ];
  for (const value of [process.env["CLAUDE_CONFIG_DIR"], process.env["CODEX_HOME"]]) {
    if (value) roots.push(value);
  }
  return roots.map((root) => resolve(root));
}

/** Windows is case-insensitive at the FS level; lower-case so `~/.CODEX` and `~/.codex` match. */
function norm(path: string): string {
  let r = resolve(path);
  if (process.platform === "win32") r = r.toLowerCase();
  while (r.length > 1 && r.endsWith(sep)) r = r.slice(0, -1);
  return r;
}

export function isProtected(path: string): boolean {
  const target = norm(path);
  for (const root of protectedRoots()) {
    const r = norm(root);
    if (target === r || target.startsWith(r + sep)) return true;
  }
  return false;
}

/** A refusal from the boundary: a decision, not a failure, so it prints as one sentence. */
export class BoundaryError extends Error {}

/** The gate every write passes through: nothing may land in a watched CLI's own state. */
function assertOwned(path: string, what: string): void {
  if (isProtected(path)) {
    throw new BoundaryError(
      `refusing to ${what} ${path}: it is inside a watched CLI's own directory. ` +
        `tide treats Codex and Claude Code state as read-only.`,
    );
  }
}

export function mkdirOwned(path: string): void {
  assertOwned(path, "create directory");
  mkdirSync(path, { recursive: true });
}

export function writeOwned(path: string, data: string): void {
  assertOwned(path, "write");
  writeFileSync(path, data, "utf8");
}

export function appendOwned(path: string, data: string): void {
  assertOwned(path, "append to");
  appendFileSync(path, data, "utf8");
}

// ── the policy ──────────────────────────────────────────────────────────────────────────

export interface FilterPolicy {
  /** A quota interruption writes nothing more, so no separate "last written" instant exists. */
  minIdleMinutes: number;
  maxAgeMinutes: number | null;
  skipSubagents: boolean;
}

export interface ResumePolicy {
  prompt: string;
  /** Legacy: still bounds the Claude adapter's full-turn wait; the watcher no longer uses it. */
  timeoutMinutes: number;
}

export interface CodexConfig {
  enabled: boolean;
  /** Absolute path to the real CLI binary; empty means resolve automatically. */
  bin: string;
  /** Bounds delivery only, never the execution of a resumed turn. */
  deliveryTimeoutSeconds: number;
}

export interface ClaudeConfig {
  enabled: boolean;
  bin: string;
  autonomy: "acceptEdits" | "plan" | "default";
  /** File of environment groups, one account each; empty means the ambient environment only. */
  accounts: string;
}

export interface Config {
  stateDir: string;
  debug: boolean;
  dryRun: boolean;
  filter: FilterPolicy;
  resume: ResumePolicy;
  codex: CodexConfig;
  claude: ClaudeConfig;
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
    filter: {
      minIdleMinutes: 5,
      maxAgeMinutes: 24 * 60,
      skipSubagents: true,
    },
    resume: {
      prompt: RESUME_PROMPT,
      timeoutMinutes: 30,
    },
    codex: {
      enabled: true,
      bin: "",
      deliveryTimeoutSeconds: 20,
    },
    claude: {
      enabled: false,
      bin: "",
      autonomy: "acceptEdits",
      accounts: "",
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

export function ensureStateDir(dir: string): void {
  mkdirOwned(dir);
}

// ── the journal ─────────────────────────────────────────────────────────────────────────

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

export function createLogger(stateDir: string, debug: boolean): Logger {
  const line = (level: string, message: string) => {
    const text = `${stamp()} ${level.padEnd(5)} ${message}`;
    if (level === "ERROR") process.stderr.write(`${text}\n`);
    else process.stdout.write(`${text}\n`);
    try {
      const logsDir = join(stateDir, "logs");
      mkdirOwned(logsDir);
      const day = new Date().toISOString().slice(0, 10);
      appendOwned(join(logsDir, `${day}.log`), `${text}\n`);
    } catch {
    }
  };

  return {
    debug: (m) => debug && line("DEBUG", m),
    info: (m) => line("INFO", m),
    warn: (m) => line("WARN", m),
    error: (m) => line("ERROR", m),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
