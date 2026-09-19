/**
 * The one directory this program may write: its boundary, policy, memory and journal.
 * The CLIs' own directories are not ours; see `protectedRoots`.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type CliKind = "codex" | "claude";

// ── the boundary ────────────────────────────────────────────────────────────────────────

/**
 * Codex's and Claude Code's own state: read-only to us, always. Enforced centrally rather
 * than at each call site, where a convenience write would look perfectly reasonable.
 */
export function protectedRoots(): string[] {
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

interface Resolved {
  path: string;
  /** The deepest ancestor that exists, fully resolved; null when nothing along it does. */
  existing: string | null;
}

/**
 * Every spelling of a path folds to one form before comparison: `\\?\C:\…` and `name:stream`
 * reach the same object by another route, and NTFS reads `~/.CODEX` as `~/.codex`.
 */
function canonical(path: string): string {
  let p = resolve(path);
  if (p.startsWith("\\\\?\\UNC\\")) p = "\\\\" + p.slice(8);
  else if (p.startsWith("\\\\?\\") || p.startsWith("\\\\.\\")) p = p.slice(4);
  if (process.platform === "win32") {
    const colon = p.indexOf(":", 2);
    if (colon !== -1 && !p.startsWith("\\\\")) p = p.slice(0, colon);
    p = p.toLowerCase();
  }
  while (p.length > 1 && p.endsWith(sep)) p = p.slice(0, -1);
  return p;
}

let rootCache: { key: string; roots: Resolved[] } | null = null;

function roots(): Resolved[] {
  const key = [
    homedir(),
    process.platform,
    process.env["CLAUDE_CONFIG_DIR"],
    process.env["CODEX_HOME"],
  ].join("\u0000");
  if (rootCache?.key !== key) rootCache = { key, roots: protectedRoots().map(realish) };
  return rootCache.roots;
}

/**
 * `realpath` for a path that does not exist yet: resolve the deepest existing ancestor and
 * re-append the rest, so a junction or symlink into a protected directory still shows up.
 */
function realish(path: string): Resolved {
  const below: string[] = [];
  let head = path;
  for (;;) {
    const real = tryRealpath(head);
    if (real !== null && isDirectory(real)) {
      return { path: below.length === 0 ? real : join(real, ...below.slice().reverse()), existing: real };
    }
    const parent = dirname(head);
    if (parent === head) {
      return { path, existing: null };
    }
    below.push(basename(head));
    head = parent;
  }
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Same object on disk, for the spellings text cannot fold: `\\localhost\C$\…` and `C:\…`
 * reach one directory while sharing almost no characters.
 */
function sameObject(a: string, b: string): boolean {
  try {
    const left = statSync(a, { bigint: true });
    const right = statSync(b, { bigint: true });
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

function isInside(path: string, root: string): boolean {
  let head = path;
  for (;;) {
    if (sameObject(head, root)) return true;
    const parent = dirname(head);
    if (parent === head) return false;
    head = parent;
  }
}

export function isProtected(path: string): boolean {
  const target = realish(resolve(path));
  const targetName = canonical(target.path);
  return roots().some((root) => {
    const rootName = canonical(root.path);
    if (targetName === rootName || targetName.startsWith(rootName + sep)) return true;
    return target.existing !== null && isInside(target.existing, root.path);
  });
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
