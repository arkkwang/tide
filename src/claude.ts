import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isStoreShim, messageText, oneLine, run, Witness } from "./child.js";
import {
  SPOKEN_CHARS,
  SPOKEN_COUNT,
  type Adapter,
  type InterruptedSession,
  type QuotaInfo,
  type ResumeResult,
  type Utterance,
} from "./watch.js";
import type { ClaudeConfig, FilterPolicy, ResumePolicy } from "./store.js";

/**
 * Claude Code writes a normalized `error` enum on every API-error record, decoded from whatever
 * the provider returned; quota is decided by that field alone, never by the prose beside it.
 */
export const QUOTA_ERROR_TAG = "rate_limit";

export function resolveClaudeBin(explicit?: string): string | null {
  const candidates = [explicit, process.env["CLAUDE_BIN"]].filter((v): v is string => !!v);
  for (const candidate of candidates) {
    if (existsSync(candidate) && !isStoreShim(candidate)) return candidate;
  }
  const which = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["claude"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (which.status === 0) {
    const first = (which.stdout ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((line) => line && existsSync(line) && !isStoreShim(line));
    if (first) return first;
  }
  return null;
}

export function claudeConfigDir(): string {
  return process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
}

function resolveSetting(keys: string[]): string | null {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }
  for (const name of ["settings.json", "settings.local.json"]) {
    const path = join(claudeConfigDir(), name);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { env?: Record<string, string> };
      for (const key of keys) {
        const value = parsed.env?.[key];
        if (value) return value;
      }
    } catch {
    }
  }
  return null;
}

const ENDPOINT_KEY = "ANTHROPIC_BASE_URL";

export function resolveEndpoint(): string | null {
  return resolveSetting([ENDPOINT_KEY]);
}

export const CREDENTIAL_VARS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];

function authToken(): string | null {
  return resolveSetting(CREDENTIAL_VARS);
}

/**
 * Claude Code takes its model from any of these slots, and a transcript records only the model —
 * so a name from this list is what matches a session back to the group that declares it.
 */
const MODEL_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
];

function probeModel(): string | null {
  return resolveSetting(MODEL_KEYS);
}

export interface Account {
  env: Record<string, string>;
  models: string[];
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseAccounts(text: string): Account[] {
  const accounts: Account[] = [];
  let current: Record<string, string> | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      current = null;
      continue;
    }
    if (line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (!VARIABLE_NAME.test(key)) continue;
    if (!current) {
      current = {};
      accounts.push({ env: current, models: [] });
    }
    current[key] = unquote(line.slice(at + 1).trim());
  }

  for (const account of accounts) {
    account.models = MODEL_KEYS.map((key) => account.env[key]).filter((v): v is string => !!v);
  }
  return accounts;
}

function unquote(value: string): string {
  const quote = value[0];
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * What a model name may carry in brackets: a context-window size, as in `MiniMax-M3[1m]`. The
 * group file spells it and the transcript does not, so comparison drops it from both.
 */
const CONTEXT_SUFFIX = "[";

function modelStem(name: string): string {
  const at = name.indexOf(CONTEXT_SUFFIX);
  return (at === -1 ? name : name.slice(0, at)).trim();
}

export function accountForModel(accounts: Account[], model: string | null): Account | null {
  if (!model) return null;
  const stem = modelStem(model);
  return accounts.find((account) => account.models.some((m) => modelStem(m) === stem)) ?? null;
}

/**
 * A group file describes alternatives, not additions: the sourcing script unsets every name the
 * file mentions before applying the group it was asked for, and a resume has to do the same.
 */
export function accountEnv(
  accounts: Account[],
  account: Account | null,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!account) return base;
  const env: NodeJS.ProcessEnv = { ...base };
  for (const other of accounts) {
    for (const key of Object.keys(other.env)) delete env[key];
  }
  return { ...env, ...account.env };
}

function firstOf(env: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = env[key];
    if (value) return value;
  }
  return null;
}

const QUOTA_CACHE_MS = 60_000;

const MESSAGES_API_VERSION = "2023-06-01";

const PROBE_TIMEOUT_MS = 20_000;

function resumeArgs(sessionId: string, prompt: string, autonomy: string): string[] {
  return [
    "-p",
    "--resume",
    sessionId,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    autonomy,
    prompt,
  ];
}

const PROBE_REQUEST = { text: "1", maxTokens: 1 };

interface Credentials {
  endpoint: string | null;
  token: string | null;
  model: string | null;
}

export class ClaudeAdapter implements Adapter {
  readonly kind = "claude" as const;
  private readonly endpoint: string | null;
  private quotaCache: QuotaInfo | null = null;
  private quotaCacheAt = 0;

  constructor(
    private readonly bin: string,
    private readonly onDebug: (msg: string) => void,
    private readonly watch: FilterPolicy,
    private readonly config: ClaudeConfig,
    private readonly resumePolicy: ResumePolicy,
  ) {
    this.endpoint = resolveEndpoint();
  }

  resolveBin(): string {
    return this.bin;
  }

  async readQuota(): Promise<QuotaInfo> {
    const now = Date.now();
    if (this.quotaCache && now - this.quotaCacheAt < QUOTA_CACHE_MS) return this.quotaCache;

    const recent = await this.findInterrupted({ ...this.watch, minIdleMinutes: 0 });
    const { accounts, problem } = this.declaredAccounts();
    const notes: string[] = [];
    if (problem) notes.push(problem);
    const endpoints = [...new Set(accounts.map((a) => a.env[ENDPOINT_KEY]).filter((v): v is string => !!v))];
    if (endpoints.length > 0) notes.push(`accounts: ${endpoints.join(", ")}`);
    else if (this.endpoint) notes.push(`endpoint: ${this.endpoint}`);
    if (endpoints.length > 0 || this.endpoint) {
      notes.push("no reset instant is exposed here — recovery is detected by probing");
    }
    const blocked = recent.length > 0;
    const info: QuotaInfo = {
      allowed: !blocked,
      blockedReason: blocked ? "window" : null,
      primary: null,
      secondary: null,
      nextResetAt: null,
      plan: null,
      notes,
    };
    this.quotaCache = info;
    this.quotaCacheAt = now;
    return info;
  }

  private declaredAccounts(): { accounts: Account[]; problem: string | null } {
    const path = this.config.accounts;
    if (!path) return { accounts: [], problem: null };
    try {
      return { accounts: parseAccounts(readFileSync(path, "utf8")), problem: null };
    } catch (err) {
      return { accounts: [], problem: `accounts file: ${(err as Error).message}` };
    }
  }

  private credentialsFor(model: string | null): Credentials {
    const account = accountForModel(this.declaredAccounts().accounts, model);
    if (!account) {
      return { endpoint: resolveEndpoint(), token: authToken(), model: probeModel() };
    }
    return {
      endpoint: account.env[ENDPOINT_KEY] ?? null,
      token: firstOf(account.env, CREDENTIAL_VARS),
      model: firstOf(account.env, MODEL_KEYS),
    };
  }

  async probe(sessions: InterruptedSession[]): Promise<boolean> {
    const pending = new Map<string, Credentials>();
    const models = sessions.length > 0 ? sessions.map((s) => s.model ?? null) : [null];
    for (const model of models) {
      const credentials = this.credentialsFor(model);
      pending.set(`${credentials.endpoint ?? ""}|${credentials.model ?? ""}`, credentials);
    }
    for (const credentials of pending.values()) {
      if (!(await this.probeOne(credentials))) return false;
    }
    return true;
  }

  private async probeOne(credentials: Credentials): Promise<boolean> {
    const { endpoint, token, model } = credentials;
    if (!endpoint) {
      this.onDebug("claude probe: no endpoint configured; cannot probe");
      return false;
    }
    if (!token) {
      this.onDebug("claude probe: no auth token found");
      return false;
    }
    if (!model) {
      this.onDebug("claude probe: no model configured (ANTHROPIC_MODEL et al); cannot probe");
      return false;
    }

    const url = `${endpoint.replace(/\/+$/, "")}/v1/messages`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": MESSAGES_API_VERSION,
          "x-api-key": token,
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: PROBE_REQUEST.maxTokens,
          messages: [{ role: "user", content: PROBE_REQUEST.text }],
        }),
        signal: controller.signal,
      });

      if (response.ok) return true;

      const body = await response.text();
      this.onDebug(`claude probe: HTTP ${response.status} ${oneLine(body)}`);

      if (response.status >= 500) this.onDebug("claude probe: provider is unwell (5xx); will retry");
      return false;
    } catch (err) {
      this.onDebug(`claude probe: ${(err as Error).message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async findInterrupted(filter: FilterPolicy): Promise<InterruptedSession[]> {
    const projectsDir = join(claudeConfigDir(), "projects");
    if (!existsSync(projectsDir)) return [];

    const cutoff = filter.maxAgeMinutes === null ? 0 : Date.now() - filter.maxAgeMinutes * 60_000;
    const quietCutoff = Date.now() - filter.minIdleMinutes * 60_000;
    const found: InterruptedSession[] = [];

    for (const project of safeReaddir(projectsDir)) {
      const projectDir = join(projectsDir, project);
      if (!isDir(projectDir)) continue;
      for (const entry of safeReaddir(projectDir)) {
        if (!entry.endsWith(".jsonl")) continue;
        const file = join(projectDir, entry);
        let mtimeMs: number;
        try {
          mtimeMs = statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (mtimeMs < cutoff) continue;
        const state = inspectTranscriptTail(file);
        if (!state || !state.quotaError) continue;

        // Age is taken from the interruption, not the file: housekeeping records land after the
        // turn ended, and a refused-and-retried session stays fresh while nobody has spoken.
        const interruptedAt = state.errorAt ?? mtimeMs;
        if (interruptedAt < cutoff) continue;

        if (state.spokenAt !== null && state.spokenAt > quietCutoff) continue;

        found.push({
          cli: "claude",
          sessionId: entry.replace(/\.jsonl$/, ""),
          turnId: state.tailKey,
          cwd: state.cwd,
          interruptedAt,
          detail: state.detail,
          resetsAt: null,
          model: state.model,
          spoken: state.spoken,
        });
      }
    }

    return found.sort((a, b) => b.interruptedAt - a.interruptedAt);
  }

  async resume(session: InterruptedSession, prompt: string): Promise<ResumeResult> {
    const cwd = session.cwd && existsSync(session.cwd) ? session.cwd : process.cwd();
    const args = resumeArgs(session.sessionId, prompt, this.config.autonomy);

    const { accounts } = this.declaredAccounts();
    const account = accountForModel(accounts, session.model ?? null);
    const env = accountEnv(accounts, account, process.env);

    this.onDebug(
      `claude resume: ${this.bin} ${args.slice(0, 5).join(" ")} … (cwd=${cwd}` +
        `, account=${account?.env[ENDPOINT_KEY] ?? "this process's own"})`,
    );

    const delivered = new Witness(
      (record) =>
        record["type"] === "system" &&
        record["subtype"] === "init" &&
        record["session_id"] === session.sessionId,
    );
    const quotaAgain = new Witness((record) => record["error"] === QUOTA_ERROR_TAG);

    const minutes = this.resumePolicy.timeoutMinutes;

    const result = await run(this.bin, args, {
      cwd,
      env,
      timeoutMs: minutes * 60_000,
      onStdout: (chunk) => {
        delivered.push(chunk);
        quotaAgain.push(chunk);
      },
    });

    if (result.spawnError) {
      return { ok: false, delivered: false, via: "resume", detail: result.spawnError };
    }
    if (!delivered.seen) {
      const reason = oneLine(result.err || result.out);
      return { ok: false, delivered: false, via: "resume", detail: reason || `exit ${result.code}` };
    }
    if (result.timedOut) {
      return {
        ok: false,
        delivered: true,
        via: "resume",
        detail: `delivered, but the turn was still running after ${minutes}m (killed)`,
      };
    }
    if (quotaAgain.seen) {
      return { ok: false, delivered: true, via: "resume", detail: "delivered, but the turn hit the limit again" };
    }
    if (result.code === 0) {
      return { ok: true, delivered: true, via: "resume", detail: "session continued" };
    }
    const reason = oneLine(result.err || result.out);
    return {
      ok: false,
      delivered: true,
      via: "resume",
      detail: reason ? `delivered, then refused: ${reason}` : `delivered, then exit ${result.code}`,
    };
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The model Claude Code writes on a record it composed itself (an API error, say), so a session
 * whose newest records are all of these still belongs to whatever account answered last.
 */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * `promptSource` is the only thing separating what a person typed from what the program stored in
 * a `user` role; a record without the field is not speech, so old transcripts show none of it.
 */
const HUMAN_PROMPT_SOURCES = new Set(["typed", "queued", "suggestion_accepted"]);
const PROMPT_SOURCE = "promptSource";

interface TailState {
  quotaError: boolean;
  cwd: string;
  errorAt: number | null;
  detail: string;
  model: string | null;
  /**
   * uuid of the newest record: the cheapest identity for how far the session got, and what tells
   * one quota interruption from the next — timestamps are too coarse to.
   */
  tailKey: string | null;
  spokenAt: number | null;
  spoken: Utterance[];
}

export function inspectTranscriptTail(
  file: string,
  options: { maxBytes?: number } = {},
): TailState | null {
  const maxBytes = options.maxBytes ?? 2_000_000;
  const lines = readTailLines(file, maxBytes);
  const model = newestModel(lines);
  const spoken = recentUtterances(lines);

  let lastError: { at: number; text: string; tag: string | null } | null = null;
  let lastSuccessAfterError = false;
  let cwd = "";
  let tailKey: string | null = null;
  let spokenAt: number | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = record["type"];
    if (!tailKey && typeof record["uuid"] === "string") tailKey = record["uuid"] as string;
    if (!cwd && typeof record["cwd"] === "string") cwd = record["cwd"] as string;
    if (spokenAt === null) {
      const at = Date.parse(String(record["timestamp"] ?? "")) || 0;
      const said = type === "user" || (type === "assistant" && record["isApiErrorMessage"] !== true);
      if (said && at > 0) spokenAt = at;
    }

    if (type === "assistant") {
      if (record["isApiErrorMessage"] === true) {
        if (!lastError) {
          const message = record["message"] as { content?: unknown } | undefined;
          lastError = {
            at: Date.parse(String(record["timestamp"] ?? "")) || 0,
            tag: typeof record["error"] === "string" ? (record["error"] as string) : null,
            text: messageText(message?.content),
          };
        }
      } else if (!lastError) {
        lastSuccessAfterError = true;
        break;
      }
    }
    if (type === "user") {
      // A `user` record is also what our own resume writes, so it is not evidence the person came
      // back: reading it that way would erase the finding that triggered the resume.
      if (lastError) break;
    }
  }

  if (!lastError) {
    return {
      quotaError: false,
      cwd,
      errorAt: null,
      detail: "no recent error",
      tailKey,
      spokenAt,
      spoken,
      model,
    };
  }
  if (lastSuccessAfterError) {
    return {
      quotaError: false,
      cwd,
      errorAt: null,
      detail: "last turn succeeded",
      tailKey,
      spokenAt,
      spoken,
      model,
    };
  }

  const { tag, text } = lastError;
  return {
    quotaError: tag === QUOTA_ERROR_TAG,
    cwd,
    errorAt: lastError.at || null,
    detail: oneLine(text) || (tag ? `error: ${tag}` : "unrecognized API error"),
    tailKey,
    spokenAt,
    spoken,
    model,
  };
}

function recentUtterances(lines: string[]): Utterance[] {
  const said: Utterance[] = [];
  for (let i = lines.length - 1; i >= 0 && said.length < SPOKEN_COUNT; i--) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record["type"] !== "user") continue;
    if (!HUMAN_PROMPT_SOURCES.has(String(record[PROMPT_SOURCE]))) continue;
    const at = Date.parse(String(record["timestamp"] ?? "")) || 0;
    const text = oneLine(
      messageText((record["message"] as { content?: unknown } | undefined)?.content),
      SPOKEN_CHARS,
    );
    if (at > 0 && text) said.push({ at, text });
  }
  return said;
}

function newestModel(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record["type"] !== "assistant") continue;
    const named = (record["message"] as { model?: unknown } | undefined)?.model;
    if (typeof named === "string" && named && named !== SYNTHETIC_MODEL) return named;
  }
  return null;
}

function readTailLines(file: string, maxBytes: number): string[] {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const size = statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return [];
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, start);
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim());
  } catch {
    return [];
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
