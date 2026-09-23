export function encodeKey(name: string, applicationCursor = false): string {
  const parts = name.split("+");
  const key = parts.pop()!;
  if (!key || new Set(parts).size !== parts.length || parts.some((p) => !["Ctrl", "Alt", "Shift"].includes(p))) throw Error(`Invalid key: ${name}`);
  const ctrl = parts.includes("Ctrl"), alt = parts.includes("Alt"), shift = parts.includes("Shift");
  const modifier = 1 + Number(shift) + Number(alt) * 2 + Number(ctrl) * 4;
  const cursor = { Up: "A", Down: "B", Right: "C", Left: "D", Home: "H", End: "F" }[key];
  if (cursor) return modifier === 1 ? `\x1b${applicationCursor ? "O" : "["}${cursor}` : `\x1b[1;${modifier}${cursor}`;
  const tilde = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 }[key];
  if (tilde) return `\x1b[${tilde}${modifier === 1 ? "" : `;${modifier}`}~`;
  const functionKey = { F1: "P", F2: "Q", F3: "R", F4: "S" }[key];
  if (functionKey) return modifier === 1 ? `\x1bO${functionKey}` : `\x1b[1;${modifier}${functionKey}`;
  if (key === "Tab" && shift && !ctrl && !alt) return "\x1b[Z";
  if (shift) throw Error(`${name} requires a terminal-specific keyboard protocol; unsupported`);
  let value: string | undefined;
  if (ctrl) {
    if (/^[A-Za-z]$/.test(key)) value = String.fromCharCode(key.toUpperCase().charCodeAt(0) - 64);
    else if (key === "Space") value = "\0";
  } else {
    value = { Enter: "\r", Escape: "\x1b", Tab: "\t", Backspace: "\x7f", Space: " " }[key];
    if (!value && alt && /^[a-zA-Z0-9]$/.test(key)) value = key;
  }
  if (value === undefined) throw Error(`Unsupported key: ${name}. Use named keys such as Enter, Up, Ctrl+C, Alt+B, Shift+Tab or Ctrl+Shift+Left`);
  return alt ? `\x1b${value}` : value;
}
