import xterm from "@xterm/headless";
import type { Snapshot } from "./types.js";

export const MAX_CAPTURE_LINES = 2000;

export class Screen {
  private readonly terminal: xterm.Terminal;
  private pending = Promise.resolve();
  private title = "";

  constructor(cols: number, rows: number) {
    this.terminal = new xterm.Terminal({ cols, rows, scrollback: MAX_CAPTURE_LINES, allowProposedApi: true });
    this.terminal.onTitleChange((title) => { this.title = title; });
  }

  write(data: string): Promise<void> {
    this.pending = new Promise((resolve) => this.terminal.write(data, resolve));
    return this.pending;
  }

  async modes() { await this.pending; return this.terminal.modes; }

  resize(cols: number, rows: number) { this.terminal.resize(cols, rows); }

  async capture(id: string, lines = this.terminal.rows): Promise<Snapshot> {
    if (!Number.isInteger(lines) || lines < 1 || lines > MAX_CAPTURE_LINES) throw Error(`--lines must be 1..${MAX_CAPTURE_LINES}`);
    await this.pending;
    const buffer = this.terminal.buffer.active;
    const end = Math.min(buffer.length, buffer.baseY + this.terminal.rows);
    const text = [];
    for (let row = Math.max(0, end - lines); row < end; row++) text.push(buffer.getLine(row)?.translateToString(true) ?? "");
    return { id, capturedAt: new Date().toISOString(), cols: this.terminal.cols, rows: this.terminal.rows, buffer: buffer.type, title: this.title, text: text.join("\n") };
  }

  dispose() { this.terminal.dispose(); }
}

export function encodeText(text: string, bracketedPaste: boolean): string {
  if (typeof text !== "string" || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) throw Error("send accepts text only; use send-key for control keys");
  if (!bracketedPaste && /[\n\t]/.test(text)) throw Error("Multiline text and tabs require bracketed paste mode in the target application");
  return bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text;
}
