import xterm from "@xterm/headless";
import type { Snapshot } from "../session/types.js";
import { performance } from "node:perf_hooks";

export const MAX_CAPTURE_LINES = 2000;

export const screenContent = (snapshot: Pick<Snapshot, "cols" | "rows" | "buffer" | "text">) => JSON.stringify([snapshot.cols, snapshot.rows, snapshot.buffer, snapshot.text]);

export class Screen {
  private readonly terminal: xterm.Terminal;
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
    this.terminal.onTitleChange((title) => { this.title = title; });
    for (const final of ["h", "l"]) this.terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
      for (const param of params) {
        if (typeof param !== "number") continue;
        if (param === 1006) this.sgrMouseEnabled = final === "h";
        else if ([1005, 1015, 1016].includes(param)) this.otherMouseEnabled = final === "h";
      }
      return false;
    });
    this.terminal.parser.registerEscHandler({ final: "c" }, () => { this.sgrMouseEnabled = false; this.otherMouseEnabled = false; return false; });
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
    if (["none", "x10"].includes(this.terminal.modes.mouseTrackingMode) || !this.sgrMouseEnabled || this.otherMouseEnabled) throw Error("Foreground program has not enabled supported SGR mouse scrolling; use capture --lines for shell history or explicit send-key navigation");
    return `\x1b[<${direction === "up" ? 64 : 65};${col};${row}M`.repeat(steps);
  }

  resize(cols: number, rows: number) { this.terminal.resize(cols, rows); this.updateActivity(); }

  async capture(id: string, lines = this.terminal.rows): Promise<Snapshot> {
    if (!Number.isInteger(lines) || lines < 1 || lines > MAX_CAPTURE_LINES) throw Error(`--lines must be 1..${MAX_CAPTURE_LINES}`);
    await this.pending;
    return this.snapshot(id, lines);
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
  if (typeof text !== "string" || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) throw Error("send accepts text only; use send-key for control keys");
  if (!/[\n\t]/.test(text)) return text;
  if (!bracketedPaste) throw Error("Multiline text and tabs require bracketed paste mode in the target application");
  return `\x1b[200~${text}\x1b[201~`;
}
