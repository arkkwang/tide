/** Normalize an OpenAI/Claude-style `content` payload to a flat string. `content` is either a
 * plain string or an array of parts whose `.text` carries the visible text — both shapes are
 * flattened, with non-text parts collapsed to empty so they contribute nothing to the result. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "",
      )
      .join(" ");
  }
  return "";
}

const MESSAGE_CHARS = 300;

/** Collapse whitespace and truncate to one line, for displaying prose in fixed-width status output. */
export function oneLine(text: string, maxChars = MESSAGE_CHARS): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > maxChars ? `${t.slice(0, maxChars)}…` : t;
}

/** Render a duration in milliseconds as `Nh Nm`, `Nm Ns`, or `Ns`. */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${seconds}s`;
}

/** Display the first 8 characters of a session id, the width that fits a status line. */
export function short(id: string): string {
  return id.slice(0, 8);
}

/** Local-time `HH:MM:SS`, for timestamps in operator-facing logs. Avoids the UTC half of the day
 * that `toISOString()` would otherwise print on machines not in the GMT offset. */
export function localTimestamp(d: Date = new Date()): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/** Render a duration as "X hour(s) Y minute(s) Z second(s)" — a verbose form for logs that
 * ask "how long has this been idle". Distinct from `formatDuration`, which is the compact
 * `Nh Mm / Mm Ss / Ss` form reserved for status timestamps. */
export function humanizeIdleDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  if (seconds > 0) parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);
  if (parts.length === 0) parts.push("0 seconds");
  return parts.join(" ");
}