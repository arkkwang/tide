// xterm's snapshot contains parsed state, not an unfinished escape sequence.
// Keep only that suffix so a newly attached parser can consume the next PTY chunk.
// This is framing, not a second terminal emulator.
export class PendingVT {
  private state: "text" | "escape" | "intermediate" | "csi" | "string" | "string-escape" = "text";
  private suffix = "";
  private overflow = false;
  private osc = false;

  write(data: string) {
    for (const char of data) {
      const code = char.charCodeAt(0);
      if (this.state === "text") {
        if (char === "\x1b") { this.state = "escape"; this.suffix = char; }
        else if (char === "\x9b") { this.state = "csi"; this.suffix = char; }
        else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
          this.state = "string"; this.osc = code === 0x9d; this.suffix = char;
        }
        continue;
      }
      if (this.suffix.length < 65536) this.suffix += char; else this.overflow = true;
      if (char === "\x18" || char === "\x1a") { this.reset(); continue; }
      if (this.state === "string" || this.state === "string-escape") {
        if (char === "\x9c" || (this.osc && char === "\x07") || (this.state === "string-escape" && char === "\\")) this.reset();
        else this.state = char === "\x1b" ? "string-escape" : "string";
      } else if (char === "\x1b") {
        this.state = "escape"; this.suffix = char; this.overflow = false;
      } else if (this.state === "escape") {
        if (char === "[") this.state = "csi";
        else if (["]", "P", "X", "^", "_"].includes(char)) { this.state = "string"; this.osc = char === "]"; }
        else if (code >= 0x20 && code <= 0x2f) this.state = "intermediate";
        else if (code >= 0x30 && code <= 0x7e) this.reset();
      } else if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.reset();
      } else if (code >= 0x30 && code <= 0x7e) this.reset();
    }
  }

  private reset() { this.state = "text"; this.suffix = ""; this.overflow = false; }
  serialize() {
    if (this.overflow) throw Error("Cannot attach during an oversized unfinished terminal sequence");
    return this.suffix;
  }
}
