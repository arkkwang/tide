import xterm from "@xterm/headless";
import type { Snapshot } from "../session/types.js";
import { performance } from "node:perf_hooks";

export const MAX_CAPTURE_LINES = 2000;

export const screenContent = (snapshot: Pick<Snapshot, "cols" | "rows" | "buffer" | "text">) => JSON.stringify([snapshot.cols, snapshot.rows, snapshot.buffer, snapshot.text]);

export class Screen {
  private readonly terminal: xterm.Terminal;
  // Read state belongs to this session's screen, not to idle/plugin captures.
  private promptMarker: xterm.IMarker | undefined;
  private regions: Array<{ marker: xterm.IMarker; end?: xterm.IMarker; readText?: string }> = [];
  private historyOmitted = false;
  private pending = Promise.resolve();
  private title = "";
  private content = "";
  private changedAt: number;
  private lastOutputAt: string | null = null;
  // SGR (DECSET 1006) mouse scroll requires exactly that encoding and no
  // other SGR-style encoding (1005/1015/1016). Two booleans track the pair.
  private sgrMouseEnabled = false;
  private otherMouseEnabled = false;

  constructor(cols: number, rows: number, private readonly now = () => performance.now()) {
    this.changedAt = now();
    this.terminal = new xterm.Terminal({ cols, rows, scrollback: MAX_CAPTURE_LINES, allowProposedApi: true });
    this.terminal.parser.registerOscHandler(133, (data) => {
      if (this.terminal.buffer.active.type !== "normal") return false;
      if (data === "A") {
        // Repeated prompt redraws without execution do not start a new task.
        if (this.promptMarker && !this.regions.some((r) => r.marker === this.promptMarker || r.end === this.promptMarker)) this.promptMarker.dispose();
        this.promptMarker = this.terminal.registerMarker(0);
        const last = this.regions.at(-1);
        if (last && !last.end && this.promptMarker) last.end = this.promptMarker;
      } else if (data === "C" && this.promptMarker && !this.promptMarker.isDisposed) {
        if (!this.regions.some((r) => r.marker === this.promptMarker)) {
          this.regions = this.regions.filter((r) => !r.marker.isDisposed);
          this.regions.push({ marker: this.promptMarker });
        }
      }
      return false;
    });
    this.terminal.parser.registerCsiHandler({ final: "J" }, (params) => {
      if (this.terminal.buffer.active.type === "normal" && (params[0] === 2 || params[0] === 3)) this.resetRead();
      return false;
    });
    this.terminal.onTitleChange((title) => { this.title = title; });
    for (const final of ["h", "l"]) this.terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
      for (const param of params) {
        if (typeof param !== "number") continue;
        if (param === 1006) this.sgrMouseEnabled = final === "h";
        else if ([1005, 1015, 1016].includes(param)) this.otherMouseEnabled = final === "h";
      }
      return false;
    });
    this.terminal.parser.registerEscHandler({ final: "c" }, () => { this.sgrMouseEnabled = false; this.otherMouseEnabled = false; this.resetRead(); return false; });
    this.content = screenContent(this.snapshot("", rows));
  }

  write(data: string): Promise<void> {
    if (data.length) this.lastOutputAt = new Date().toISOString();
    this.pending = new Promise((resolve) => this.terminal.write(data, () => { this.updateActivity(); resolve(); }));
    return this.pending;
  }

  private updateActivity() {
    const content = screenContent(this.snapshot("", this.terminal.rows));
    if (content !== this.content) { this.content = content; this.changedAt = this.now(); }
  }

  async activity() {
    await this.pending;
    return { idleForMs: Math.max(0, Math.round(this.now() - this.changedAt)), lastOutputAt: this.lastOutputAt };
  }

  async modes() { await this.pending; return this.terminal.modes; }

  async scroll(direction: string, steps: number, x?: number, y?: number) {
    await this.pending;
    if (!["up", "down"].includes(direction) || !Number.isInteger(steps) || steps < 1 || steps > 100) throw Error("scroll requires up/down and --steps 1..100");
    const col = x ?? Math.ceil(this.terminal.cols / 2), row = y ?? Math.ceil(this.terminal.rows / 2);
    if (!Number.isInteger(col) || !Number.isInteger(row) || col < 1 || col > this.terminal.cols || row < 1 || row > this.terminal.rows) throw Error("Scroll coordinates must be 1-based cells inside the current screen");
    if (["none", "x10"].includes(this.terminal.modes.mouseTrackingMode) || !this.sgrMouseEnabled || this.otherMouseEnabled) throw Error("Foreground program has not enabled supported SGR mouse scrolling; use read --full --lines for shell history or explicit send --key navigation");
    return `\x1b[<${direction === "up" ? 64 : 65};${col};${row}M`.repeat(steps);
  }

  private resetRead() {
    for (const region of this.regions) { region.marker.dispose(); region.end?.dispose(); }
    this.promptMarker?.dispose();
    this.promptMarker = undefined;
    this.regions = [];
    this.historyOmitted = false;
  }

  resize(cols: number, rows: number) {
    if (cols !== this.terminal.cols || rows !== this.terminal.rows) this.resetRead();
    this.terminal.resize(cols, rows); this.updateActivity();
  }

  async capture(id: string, lines = this.terminal.rows): Promise<Snapshot> {
    if (!Number.isInteger(lines) || lines < 1 || lines > MAX_CAPTURE_LINES) throw Error(`--lines must be 1..${MAX_CAPTURE_LINES}`);
    await this.pending;
    return this.snapshot(id, lines);
  }

  async read(id: string, lines?: number, full = false): Promise<Snapshot> {
    if (lines !== undefined && (!Number.isInteger(lines) || lines < 1 || lines > MAX_CAPTURE_LINES)) throw Error(`--lines must be 1..${MAX_CAPTURE_LINES}`);
    if (typeof full !== "boolean") throw Error("--full must be boolean");
    await this.pending;
    const buffer = this.terminal.buffer.active;
    // Rows below the last used row are unused screen space, so every read path
    // stops at the cursor row at the latest. A row counts as used only when it
    // carries non-whitespace content; blank rows between content stay intact.
    const usedEnd = (end: number) => {
      while (end > buffer.baseY + buffer.cursorY + 1 && !buffer.getLine(end - 1)?.translateToString(true).trim()) end--;
      return end;
    };
    if (buffer.type !== "normal" || !this.regions.length) {
      // Unintegrated shells and full-screen applications keep the screen contract
      // but drop that unused padding. A default screen read never backfills above
      // the window to make up for the trimmed rows.
      const end = usedEnd(Math.min(buffer.length, buffer.baseY + this.terminal.rows));
      const start = Math.max(lines === undefined && !full ? buffer.baseY : 0, end - (lines ?? (full ? MAX_CAPTURE_LINES : this.terminal.rows)));
      const text: string[] = [];
      for (let row = start; row < end; row++) text.push(buffer.getLine(row)?.translateToString(true) ?? "");
      return { id, capturedAt: new Date().toISOString(), cols: this.terminal.cols, rows: this.terminal.rows,
        buffer: buffer.type, title: this.title, text: text.join("\n"),
        cursor: { row: buffer.baseY + buffer.cursorY - start, col: buffer.cursorX } };
    }
    // When a long task's start leaves scrollback, its retained tail is still
    // the current task. Keep that last record until another command starts.
    this.regions = this.regions.filter((r, i, all) => !r.marker.isDisposed || i === all.length - 1);
    const end = usedEnd(Math.min(buffer.length, buffer.baseY + this.terminal.rows));
    const regionText = (region: typeof this.regions[number]) => {
      const stop = region.end && !region.end.isDisposed ? region.end.line : end;
      const rows: string[] = [];
      for (let i = Math.max(0, region.marker.line); i < stop; i++) rows.push(buffer.getLine(i)?.translateToString(true) ?? "");
      return rows.join("\n").trimEnd();
    };
    let start = 0;
    if (!full) {
      // Keep the newest task even after completion, plus any earlier unread tasks.
      const firstUnread = this.regions.findIndex((r) => r.readText !== regionText(r));
      const keep = firstUnread < 0 ? this.regions.length - 1 : firstUnread;
      if (keep > 0 || this.historyOmitted) start = Math.max(0, this.regions[keep]!.marker.line);
    }
    const omittedHistoryLines = start;
    const limitedStart = Math.max(start, end - (lines ?? MAX_CAPTURE_LINES));
    const text: string[] = [];
    for (let row = limitedStart; row < end; row++) text.push(buffer.getLine(row)?.translateToString(true) ?? "");
    // A cropped task is not marked fully read. The latest completed task remains
    // available until another task starts, regardless of repeated reads.
    for (let i = 0; i < this.regions.length; i++) {
      const region = this.regions[i]!;
      const next = region.end && !region.end.isDisposed ? region.end.line : end;
      if (Math.max(0, region.marker.line) >= limitedStart && next <= end) region.readText = regionText(region);
    }
    // Bound bookkeeping by the terminal's retained history (disposed markers are
    // removed above). Do not remove old markers: --full can revisit those tasks.
    this.historyOmitted ||= omittedHistoryLines > 0;
    const prefix = omittedHistoryLines ? `[Earlier read history omitted: ${omittedHistoryLines} lines]\n` : "";
    const limited = limitedStart - start;
    const notice = limited ? `[Earlier content outside line limit: ${limited} lines]\n` : "";
    return { id, capturedAt: new Date().toISOString(), cols: this.terminal.cols, rows: this.terminal.rows,
      buffer: buffer.type, title: this.title, text: prefix + notice + text.join("\n"),
      omittedHistoryLines, limitedLines: limited,
      cursor: { row: buffer.baseY + buffer.cursorY - limitedStart + Number(!!prefix) + Number(!!notice), col: buffer.cursorX } };
  }

  private snapshot(id: string, lines: number): Snapshot {
    const buffer = this.terminal.buffer.active;
    const end = Math.min(buffer.length, buffer.baseY + this.terminal.rows);
    const text = [];
    for (let row = Math.max(0, end - lines); row < end; row++) text.push(buffer.getLine(row)?.translateToString(true) ?? "");
    return { id, capturedAt: new Date().toISOString(), cols: this.terminal.cols, rows: this.terminal.rows, buffer: buffer.type, title: this.title, text: text.join("\n"),
      cursor: { row: buffer.baseY + buffer.cursorY - Math.max(0, end - lines), col: buffer.cursorX } };
  }

  dispose() { this.terminal.dispose(); }
}

// Only text that cannot be sent as typed text needs the paste wrapper: a single
// line without tabs goes raw, so a target that is not in paste mode receives it
// unharmed instead of a literal ESC[200~ marker.
export function encodeText(text: string, bracketedPaste: boolean): string {
  if (typeof text !== "string" || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) throw Error("Text input must be a string without control characters; use send --key for control keys");
  if (!/[\n\t]/.test(text)) return text;
  if (!bracketedPaste) throw Error("Multiline text and tabs require bracketed paste mode in the target application");
  return `\x1b[200~${text}\x1b[201~`;
}
