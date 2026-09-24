import type { Snapshot } from "../../session/types.js";

export type CliKind = "codex" | "claude";
export type InterruptionKind = "quota" | "connection";
export interface Interruption { kind: InterruptionKind; message: string }
export interface ResumeScreen { matched: boolean; ready: boolean; interruption: Interruption | null }

// A pattern can be either a plain string (matched as a case-insensitive prefix
// against the first row of the response) or a RegExp (tested against the same
// row). Add new entries to whichever list applies when a CLI changes wording;
// shared phrases can be duplicated in both lists.
export type Pattern = string | RegExp;

const QUOTA_PATTERNS: Record<CliKind, readonly Pattern[]> = {
  claude: [
    "API Error: Request rejected (429)",     // current Claude Code wording
    "You have exceeded",                      // Claude Code future-proof
    "You've hit your limit",                  // legacy Claude Code wording
    "usage limit",
    "rate limit",
    /exceeded retry limit, last status: 429\b/,
    "达到使用上限",
    "已达上限",
    "使用限流",
  ],
  codex: [
    "You've hit your limit",                  // shared Claude-Code-style wording
    "exceeded your usage limit",
    "usage limit",
    "rate limit",
    /exceeded retry limit, last status: 429\b/,
    "达到使用上限",
    "已达上限",
  ],
};

const CONNECTION_PATTERNS: Record<CliKind, readonly Pattern[]> = {
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
};

const RETRYING_PATTERNS: readonly Pattern[] = [/retrying in \d/i, /reconnecting/i, /正在重试/, /正在重新连接/];
// Auth/authz errors shouldn't trigger probes (no point retrying).
const AUTH_PATTERNS: readonly Pattern[] = [/\b401\b/, /\b403\b/, /\b400\b/, /\b404\b/, /unauthorized/i, /authentication/i, /invalid api key/i, /permission denied/i];

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
    // Find the latest response above the prompt: skip decorations (empty rows,
    // horizontal separators, spinner lines, percentage notifications), then
    // take the first content row plus any indented continuation rows above it.
    // If the first row is itself indented, walk up to its non-indented start.
    const decoration = (line: string) =>
      !line || /^[─━═\-]+$/.test(line) || /^\d+%\s/.test(line);
    let i = index - 1;
    while (i >= 0 && decoration(rows[i]!.trim())) i--;
    if (i >= 0) {
      let main = i;
      while (main > 0 && /^\s/.test(rows[main]!)) main--;
      const response = rows.slice(main, i + 1).join("\n").trim();
      const firstRow = rows[main]!.replace(/^[⎿●■⚠!]\s*/, "").trim();
      let kindResult: "quota" | "connection" | null = null;
      if (matchAny(firstRow, QUOTA_PATTERNS[kind])) kindResult = "quota";
      else if (matchAny(firstRow, CONNECTION_PATTERNS[kind])) kindResult = "connection";
      if (kindResult && !matchAny(response, RETRYING_PATTERNS)
        && !matchAny(response, AUTH_PATTERNS)) {
        interruption = { kind: kindResult, message: response };
      }
    }
  }
  return { matched: branded && !outside, ready, interruption };
}