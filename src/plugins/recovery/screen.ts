import type { Snapshot } from "../../session/types.js";

export type CliKind = "codex" | "claude";
export type InterruptionKind = "quota" | "connection";
export interface Interruption { kind: InterruptionKind; message: string }
export interface ResumeScreen { matched: boolean; ready: boolean; interruption: Interruption | null }

const limit = /^(?:you(?:'|’)ve (?:hit|reached) (?:your |the )?(?:usage )?limit|you have (?:hit|reached) (?:your |the )?(?:usage )?limit|usage limit (?:reached|exceeded)|rate[ _-]?limit(?:ed| reached| exceeded| error)|api error:\s*429\b|error:\s*(?:429\b|usage limit|rate limit)|(?:已达到|已达|超出|超过).*(?:限额|额度|使用上限)|(?:请求|使用).*(?:限流|已达上限))/i;
const connection = /^(?:(?:api error:\s*|error:\s*)?(?:connection (?:error|failed|reset|closed)|network (?:error|unavailable)|request (?:timed out|timeout)|stream disconnected before completion|error (?:sending request|during communication)|failed to (?:connect|send request)|fetch failed|socket hang up|ECONNRESET\b|ETIMEDOUT\b)|api error:\s*(?:502|503|504|529)\b|exceeded retry limit, last (?:error|status):)/i;
const retrying = /\b(?:retrying|reconnecting)(?:\b|\.{3})|\bretry(?:ing)? in \d|正在重试|正在重新连接/i;

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
  // A later shell prompt or modal footer means the old CLI prompt is only history.
  const outside = /(?:^|\n)\s*(?:\$|PS [^\n]*>|[^\n]*[#$])\s*$/.test(footer)
    || /Do you want to|Allow this|Yes,|Enter to confirm/i.test(footer);
  const busy = /esc to interrupt|esc to cancel/i.test(footer);
  const prefix = prompt.exec(rows[index]!)![0];
  const ready = branded && !outside && !busy && rows[index]!.slice(prefix.length).trim() === "" && (snapshot.cursor
    ? snapshot.cursor.row === index && snapshot.cursor.col <= prefix.trimEnd().length + 1
    : rows[index]!.slice(prefix.length).trim() === "");
  let interruption: Interruption | null = null;
  // Inspect only the latest response above the current composer, bottom to top.
  for (let i = index - 1; i >= Math.max(0, index - 12); i--) {
    const line = rows[i]!.trim();
    if (!line || /^[─━═\-]+$/.test(line) || /^(?:resets? |try again |(?:[✻✽✳*] )?(?:Worked|Cooked|Baked) for\b)/i.test(line)) continue;
    const message = line.replace(/^[⎿●■⚠!]\s*/, "");
    if (retrying.test(message)) break;
    if (limit.test(message) || /^exceeded retry limit, last status:\s*429\b/i.test(message)) { interruption = { kind: "quota", message }; break; }
    if (connection.test(message) && !/\b(?:401|403|400|404)\b|unauthorized|authentication|invalid.api.key|permission denied/i.test(message)) {
      interruption = { kind: "connection", message }; break;
    }
    // Never reach past a newer message to revive an old quota banner.
    break;
  }
  return { matched: branded && !outside, ready, interruption: ready ? interruption : null };
}
