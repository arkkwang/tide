import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, type Snapshot } from "../../session/types.js";
import { stateDirectory } from "../../session/registry.js";

export type CliKind = "codex" | "claude";
export type InterruptionKind = "quota" | "connection";
export interface Interruption { kind: InterruptionKind; message: string }
export interface ResumeScreen { matched: boolean; ready: boolean; interruption: Interruption | null }

// A pattern is either a literal string (matched as a case-insensitive prefix
// against the first row of the response) or a RegExp (tested against the same
// row). All four pattern lists are kept per CLI so a single config entry can
// be tightened to one CLI without affecting the other.
export type Pattern = string | RegExp;

export type PatternsConfig = {
  quota: Record<CliKind, readonly Pattern[]>;
  connection: Record<CliKind, readonly Pattern[]>;
  retrying: Record<CliKind, readonly Pattern[]>;
  auth: Record<CliKind, readonly Pattern[]>;
  // Per-CLI regex anchoring the prefix that marks a row as a CLI response
  // (e.g. Claude's `● API Error: …`). Same regex is used to test rows and to
  // strip the prefix before matching against quota/connection patterns.
  rowMarker: Record<CliKind, RegExp>;
};

// Defaults if `${TIDE_STATE_DIR}/resume-patterns.json` is absent or invalid.
// Editing these never reaches the user unless they delete their config file.
const BUNDLED_PATTERNS: PatternsConfig = {
  rowMarker: {
    claude: /^\s*[⎿●■⚠!]\s/,
    codex: /^\s*[⎿●■⚠!]\s/,
  },
  quota: {
    claude: [
      "API Error: Request rejected (429)",
      "You have exceeded",
      "You've hit your limit",
      "usage limit",
      "rate limit",
      /exceeded retry limit, last status: 429\b/,
      "达到使用上限",
      "已达上限",
      "使用限流",
    ],
    codex: [
      "You've hit your limit",
      "exceeded your usage limit",
      "usage limit",
      "rate limit",
      /exceeded retry limit, last status: 429\b/,
      "达到使用上限",
      "已达上限",
    ],
  },
  connection: {
    claude: [
      /^(?:api error:\s*)?connection (?:error|failed|reset|closed)/i,
      /^(?:api error:\s*)?network (?:error|unavailable)/i,
      /^(?:api error:\s*)?request (?:timed out|timeout)/i,
      "stream disconnected",
      /^api error:\s*(?:502|503|504|529)/i,
      /exceeded retry limit, last status: 5\d\d\b/,
    ],
    codex: [
      /^(?:api error:\s*)?connection (?:error|failed|reset|closed)/i,
      /^(?:api error:\s*)?network (?:error|unavailable)/i,
      /^(?:api error:\s*)?request (?:timed out|timeout)/i,
      "stream disconnected",
      "econnreset",
      /exceeded retry limit, last status: 5\d\d\b/,
    ],
  },
  retrying: {
    claude: [/retrying in \d/i, /reconnecting/i, /正在重试/, /正在重新连接/],
    codex: [/retrying in \d/i, /reconnecting/i, /正在重试/, /正在重新连接/],
  },
  auth: {
    claude: [/\b401\b/, /\b403\b/, /\b400\b/, /\b404\b/, /unauthorized/i, /authentication/i, /invalid api key/i, /permission denied/i],
    codex: [/\b401\b/, /\b403\b/, /\b400\b/, /\b404\b/, /unauthorized/i, /authentication/i, /invalid api key/i, /permission denied/i],
  },
};

const PATTERN_FILE = "resume-patterns.json";

// User config replaces the bundled defaults entirely. A string with form
// `/pattern/flags` is compiled as a RegExp; any other string is treated as a
// case-insensitive prefix literal that matchAny applies with startsWith.
const REGEX_PREFIX = /^\/(.+)\/([a-z]*)$/;
export function compilePattern(entry: unknown, where: string): Pattern {
  if (typeof entry !== "string") throw Error(`${where}: expected string, got ${typeof entry}`);
  const match = entry.match(REGEX_PREFIX);
  if (match) {
    try { return new RegExp(match[1]!, match[2]!); }
    catch (error) { throw Error(`${where}: invalid regex /${match[1]}/${match[2]}: ${errorMessage(error)}`); }
  }
  return entry;
}

function requireCliList(value: unknown, where: string): Record<CliKind, readonly Pattern[]> {
  if (!value || typeof value !== "object") throw Error(`${where}: expected object with claude and codex arrays`);
  const obj = value as Record<string, unknown>;
  function requireSide(side: CliKind): readonly Pattern[] {
    if (!Array.isArray(obj[side])) throw Error(`${where}.${side}: expected array`);
    return (obj[side] as unknown[]).map((entry, i) => compilePattern(entry, `${where}.${side}[${i}]`));
  }
  return { claude: requireSide("claude"), codex: requireSide("codex") };
}

function compileMarker(entry: unknown, where: string): RegExp {
  if (typeof entry !== "string") throw Error(`${where}: expected regex source string`);
  try { return new RegExp(entry); }
  catch (error) { throw Error(`${where}: invalid regex /${entry}/: ${errorMessage(error)}`); }
}

function parseConfig(json: unknown, file: string): PatternsConfig {
  if (!json || typeof json !== "object") throw Error(`${file}: expected object`);
  const obj = json as Record<string, unknown>;
  for (const field of ["quota", "connection", "retrying", "auth", "rowMarker"]) {
    if (!(field in obj)) throw Error(`${file}: missing required field "${field}"`);
  }
  if (!obj.rowMarker || typeof obj.rowMarker !== "object") throw Error(`${file}#rowMarker: expected object with claude and codex regex sources`);
  const rm = obj.rowMarker as Record<string, unknown>;
  for (const side of ["claude", "codex"]) {
    if (typeof rm[side] !== "string") throw Error(`${file}#rowMarker.${side}: expected regex source string`);
  }
  return {
    quota: requireCliList(obj.quota, `${file}#quota`),
    connection: requireCliList(obj.connection, `${file}#connection`),
    retrying: requireCliList(obj.retrying, `${file}#retrying`),
    auth: requireCliList(obj.auth, `${file}#auth`),
    rowMarker: {
      claude: compileMarker(rm.claude, `${file}#rowMarker.claude`),
      codex: compileMarker(rm.codex, `${file}#rowMarker.codex`),
    },
  };
}

export function loadPatternsFromFile(file: string): PatternsConfig {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (error) { throw Error(`Cannot read ${file}: ${errorMessage(error)}`); }
  let json: unknown;
  try { json = JSON.parse(raw); }
  catch (error) { throw Error(`Invalid JSON in ${file}: ${errorMessage(error)}`); }
  return parseConfig(json, file);
}

// Lazy so test setups that mutate process.env.TIDE_STATE_DIR after import get
// observed. Production callers invoke this via inspectScreen which always
// resolves the current env, so there is no init-order risk in the host.
let PATTERNS: PatternsConfig | undefined;
function patterns(): PatternsConfig {
  if (!PATTERNS) {
    const dir = process.env.TIDE_STATE_DIR || stateDirectory();
    const file = join(dir, PATTERN_FILE);
    PATTERNS = existsSync(file) ? loadPatternsFromFile(file) : BUNDLED_PATTERNS;
  }
  return PATTERNS;
}

// Tests that mutate env between cases can call this to force a re-read.
export function resetPatterns(): void { PATTERNS = undefined; }

export function getPatterns(): PatternsConfig { return patterns(); }

function matchAny(text: string, patterns: readonly Pattern[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some((p) => typeof p === "string" ? lower.startsWith(p.toLowerCase()) : p.test(text));
}

export function inspectScreen(kind: CliKind, snapshot: Snapshot): ResumeScreen {
  const rows = snapshot.text.split("\n");
  const prompt = kind === "claude" ? /^\s*[❯>]\s?/ : /^\s*›\s?/;
  let index = rows.length - 1;
  while (index >= 0 && !prompt.test(rows[index]!)) index--;
  if (index < 0) return { matched: false, ready: false, interruption: null };

  const footer = rows.slice(index + 1).join("\n");
  const branded = kind === "claude"
    ? /bypass permissions|shift\+tab to cycle|\? for shortcuts/i.test(footer)
    : /context left|\? for shortcuts/i.test(footer);
  const outside = /(?:^|\n)\s*(?:\$|PS [^\n]*>|[^\n]*[#$])\s*$/.test(footer)
    || /Do you want to|Allow this|Yes,|Enter to confirm/i.test(footer);
  const busy = /esc to interrupt|esc to cancel/i.test(footer);
  const prefix = prompt.exec(rows[index]!)![0];
  // Trust the prompt row and footer keywords; cursor-in-prompt is unreliable
  // in Claude Code's alt buffer.
  const ready = branded && !outside && !busy && rows[index]!.slice(prefix.length).trim() === "";

  let interruption: Interruption | null = null;
  if (ready) {
    // Walk upward from above the prompt and take the first row matching the
    // per-CLI row marker as the latest response. Anything else between the
    // prompt and that row (spinner tails, completion timers, separators,
    // plain prose) is ignored.
    const cfg = patterns();
    const marker = cfg.rowMarker[kind];
    let i = index - 1;
    while (i >= 0 && !marker.test(rows[i]!)) i--;
    if (i >= 0) {
      const firstRow = rows[i]!.replace(marker, "").trim();
      let kindResult: "quota" | "connection" | null = null;
      if (matchAny(firstRow, cfg.quota[kind])) kindResult = "quota";
      else if (matchAny(firstRow, cfg.connection[kind])) kindResult = "connection";
      if (kindResult && !matchAny(firstRow, cfg.retrying[kind])
        && !matchAny(firstRow, cfg.auth[kind])) {
        interruption = { kind: kindResult, message: firstRow };
      }
    }
  }
  return { matched: branded && !outside, ready, interruption };
}
