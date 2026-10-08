import xterm from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import { PendingVT } from "./pending-vt.js";
import type { PromptState, Snapshot } from "../session/types.js";
import { performance } from "node:perf_hooks";

export const MAX_CAPTURE_LINES = 2000;
const DEFAULT_READ_HEAD_LINES = 10;
const DEFAULT_READ_TAIL_LINES = 30;

export const screenContent = (snapshot: Pick<Snapshot, "cols" | "rows" | "buffer" | "text">) => JSON.stringify([snapshot.cols, snapshot.rows, snapshot.buffer, snapshot.text]);

export class Screen {
  private readonly terminal: xterm.Terminal;
  private readonly serializer = new serialize.SerializeAddon();
  private readonly pendingVT = new PendingVT();
  private cursorVisible = true;
  private mouseEncodings = new Set<number>();
  private margins: Record<"normal" | "alternate", { top: number; bottom: number } | undefined> = { normal: undefined, alternate: undefined };
  // Prompt and latest executed command boundaries; reads are stateless.
  private promptMarker: xterm.IMarker | undefined;
  private latestMarker: xterm.IMarker | undefined;
  private inputStart: { marker: xterm.IMarker; col: number } | undefined;
  private lastCommand: string | null = null;
  // A/B are prompt side, C is the execution boundary. Kept across clear and
  // resize: neither changes which side of the last boundary the shell is on.
  private promptState: PromptState = "unknown";
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
    // The addon uses the same buffer API in headless and browser xterm.
    this.terminal.loadAddon(this.serializer as unknown as xterm.ITerminalAddon);
    this.terminal.parser.registerCsiHandler({ final: "r" }, (params) => {
      const top = Number(params[0]) || 1, bottom = Number(params[1]) || this.terminal.rows;
      if (top >= 1 && top < bottom && bottom <= this.terminal.rows) this.margins[this.terminal.buffer.active.type] = { top, bottom };
      return false;
    });
    this.terminal.parser.registerOscHandler(133, (data) => {
      if (this.terminal.buffer.active.type !== "normal") return false;
      if (data === "A") {
        this.promptState = "at-prompt";
        this.clearInputStart();
        if (this.promptMarker !== this.latestMarker) this.promptMarker?.dispose();
        this.promptMarker = this.terminal.registerMarker(0);
      } else if (data === "B" && this.promptMarker && !this.promptMarker.isDisposed) {
        this.promptState = "at-prompt";
        this.clearInputStart();
        const marker = this.terminal.registerMarker(0);
        if (marker) this.inputStart = { marker, col: this.terminal.buffer.active.cursorX };
      } else if (data === "C") {
        this.promptState = "running";
        this.lastCommand = this.submittedCommand();
        this.clearInputStart();
        if (this.promptMarker && !this.promptMarker.isDisposed) {
          if (this.latestMarker !== this.promptMarker) this.latestMarker?.dispose();
          this.latestMarker = this.promptMarker;
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
        if (param === 25) this.cursorVisible = final === "h";
        if ([1005, 1006, 1015, 1016].includes(param)) {
          if (final === "h") this.mouseEncodings.add(param); else this.mouseEncodings.delete(param);
        }
        if (param === 1049 && final === "h") this.margins.alternate = undefined;
        if (param === 1006) this.sgrMouseEnabled = final === "h";
        else if ([1005, 1015, 1016].includes(param)) this.otherMouseEnabled = final === "h";
      }
      return false;
    });
    this.terminal.parser.registerEscHandler({ final: "c" }, () => { this.sgrMouseEnabled = false; this.otherMouseEnabled = false; this.cursorVisible = true; this.mouseEncodings.clear(); this.margins = { normal: undefined, alternate: undefined }; this.resetRead(); return false; });
    this.content = screenContent(this.snapshot("", rows));
  }

  write(data: string): Promise<void> {
    if (data.length) this.lastOutputAt = new Date().toISOString();
    this.pendingVT.write(data);
    this.pending = new Promise((resolve) => this.terminal.write(data, () => { this.updateActivity(); resolve(); }));
    return this.pending;
  }

  private updateActivity() {
    const content = screenContent(this.snapshot("", this.terminal.rows));
    if (content !== this.content) { this.content = content; this.changedAt = this.now(); }
  }

  async activity() {
    await this.pending;
    return { idleForMs: Math.max(0, Math.round(this.now() - this.changedAt)), lastOutputAt: this.lastOutputAt, lastCommand: this.lastCommand, promptState: this.promptState };
  }

  async modes() { await this.pending; return this.terminal.modes; }

  onResponse(handler: (data: string) => void) { return this.terminal.onData(handler); }

  async scroll(direction: string, steps: number, x?: number, y?: number) {
    await this.pending;
    if (!["up", "down"].includes(direction) || !Number.isInteger(steps) || steps < 1 || steps > 100) throw Error("scroll requires up/down and --steps 1..100");
    const col = x ?? Math.ceil(this.terminal.cols / 2), row = y ?? Math.ceil(this.terminal.rows / 2);
    if (!Number.isInteger(col) || !Number.isInteger(row) || col < 1 || col > this.terminal.cols || row < 1 || row > this.terminal.rows) throw Error("Scroll coordinates must be 1-based cells inside the current screen");
    if (["none", "x10"].includes(this.terminal.modes.mouseTrackingMode) || !this.sgrMouseEnabled || this.otherMouseEnabled) throw Error("Foreground program has not enabled supported SGR mouse scrolling; use in-app navigation or explicit send --key navigation");
    return `\x1b[<${direction === "up" ? 64 : 65};${col};${row}M`.repeat(steps);
  }

  private clearInputStart() {
    this.inputStart?.marker.dispose();
    this.inputStart = undefined;
  }

  // Read the rendered input only at the execution boundary, before program output.
  // Soft wraps belong to one command; hard line breaks may contain PS2 prompts,
  // so multiline input is deliberately unknown rather than guessed.
  private submittedCommand(): string | null {
    const start = this.inputStart;
    if (!start || start.marker.isDisposed) return null;
    const buffer = this.terminal.buffer.active;
    const end = buffer.baseY + buffer.cursorY;
    if (end < start.marker.line) return null;
    let command = "";
    for (let row = start.marker.line; row <= end; row++) {
      const line = buffer.getLine(row);
      if (!line) return null;
      const from = row === start.marker.line ? start.col : 0;
      let to = row === end ? buffer.cursorX : this.terminal.cols;
      // Readline emits CRLF before PS0; omit that final, empty row.
      if (row === end && row > start.marker.line && to === 0) break;
      if (row > start.marker.line && !line.isWrapped) return null;
      // Empty cells are padding (including the gap before a wide glyph wraps).
      // Actual typed spaces have chars=" ": preserve them, including escaped
      // trailing spaces. translateToString(trimRight) would erase that distinction.
      while (to > from && line.getCell(to - 1)?.getChars() === "") to--;
      for (let col = from; col < to; col++) {
        const cell = line.getCell(col);
        if (!cell) return null;
        if (cell.getWidth() !== 0) command += cell.getChars() || " ";
      }
    }
    return /\S/.test(command) ? command : null;
  }

  private resetRead() {
    this.clearInputStart();
    this.latestMarker?.dispose();
    if (this.promptMarker !== this.latestMarker) this.promptMarker?.dispose();
    this.promptMarker = undefined;
    this.latestMarker = undefined;
  }

  resize(cols: number, rows: number) {
    if (cols !== this.terminal.cols || rows !== this.terminal.rows) {
      this.resetRead();
      this.margins = { normal: undefined, alternate: undefined };
    }
    this.terminal.resize(cols, rows); this.updateActivity();
  }

  // Called at the host's serialized output boundary, never concurrently with writes.
  async serialize(): Promise<string> {
    await this.pending;
    const buffer = this.terminal.buffer.active;
    const margins = this.margins[buffer.type];
    const origin = this.terminal.modes.originMode;
    // Setting origin mode/margins homes the cursor. Restore them around a saved
    // cursor (including pending wrap), rather than accepting the addon's homing.
    let serialized = this.serializer.serialize().replaceAll("\x1b[?6h", "");
    const normalMargins = this.margins.normal;
    if (buffer.type === "alternate" && normalMargins) {
      serialized = serialized.replace("\x1b[?1049h", `\x1b7\x1b[${normalMargins.top};${normalMargins.bottom}r\x1b8\x1b[?1049h`);
    }
    return "\x1bc" + serialized +
      (margins || origin ? `\x1b7${margins ? `\x1b[${margins.top};${margins.bottom}r` : ""}${origin ? "\x1b[?6h" : ""}\x1b8` : "") +
      `\x1b[?25${this.cursorVisible ? "h" : "l"}` +
      [...this.mouseEncodings].map(mode => `\x1b[?${mode}h`).join("") +
      `\x1b]2;${this.title.replace(/[\x00-\x1f\x7f-\x9f]/g, "")}\x07` + this.pendingVT.serialize();
  }

  async capture(id: string, lines = this.terminal.rows): Promise<Snapshot> {
    if (!Number.isInteger(lines) || lines < 1 || lines > MAX_CAPTURE_LINES) throw Error(`--lines must be 1..${MAX_CAPTURE_LINES}`);
    await this.pending;
    return this.snapshot(id, lines);
  }

  async read(id: string, lines?: number, full = false): Promise<Snapshot> {
    if (lines !== undefined && (!Number.isInteger(lines) || lines < 1 || lines > MAX_CAPTURE_LINES)) throw Error(`--lines must be 1..${MAX_CAPTURE_LINES}`);
    if (typeof full !== "boolean") throw Error("--full must be boolean");
    if (full && lines !== undefined) throw Error("--full and --lines are mutually exclusive");
    await this.pending;
    const buffer = this.terminal.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY;
    let end = Math.min(buffer.length, buffer.baseY + this.terminal.rows);
    while (end > cursorRow + 1 && !buffer.getLine(end - 1)?.translateToString(true).trim()) end--;
    const tracked = buffer.type === "normal" && this.latestMarker !== undefined;
    // A disposed command marker has scrolled out; its retained output starts at 0.
    const start = tracked ? Math.max(0, this.latestMarker!.line) : buffer.baseY;
    let omittedStart = start, omittedEnd = start;
    if (lines !== undefined) omittedEnd = Math.max(start, end - lines);
    else if (!full && tracked && end - start > DEFAULT_READ_HEAD_LINES + DEFAULT_READ_TAIL_LINES) {
      omittedStart = start + DEFAULT_READ_HEAD_LINES;
      omittedEnd = end - DEFAULT_READ_TAIL_LINES;
    }
    const omitted = omittedEnd - omittedStart;
    const cursorHidden = cursorRow < start || cursorRow >= end || (cursorRow >= omittedStart && cursorRow < omittedEnd);
    const text: string[] = [];
    for (let row = start; row < end; row++) {
      if (omitted && row === omittedStart) {
        text.push(`[... ${lines === undefined ? "middle" : "earlier"} output omitted${cursorHidden ? "; cursor omitted" : ""} ...]`);
        row = omittedEnd - 1;
      } else text.push(buffer.getLine(row)?.translateToString(true) ?? "");
    }
    return { id, capturedAt: new Date().toISOString(), cols: this.terminal.cols, rows: this.terminal.rows,
      buffer: buffer.type, title: this.title, text: text.join("\n"),
      ...(!cursorHidden ? { cursor: { row: cursorRow - start - (omitted && cursorRow >= omittedEnd ? omitted - 1 : 0), col: buffer.cursorX } } : {}) };
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
