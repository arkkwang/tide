import { readFileSync } from "node:fs";
import { join } from "node:path";

// Read only the top-level field; Terminal settings allow comments and trailing commas.
export function defaultProfile(text: string): string | undefined {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[{}\[\]:,]/g) ?? [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("/")) continue;
    if (token === "{" || token === "[") depth++;
    else if (token === "}" || token === "]") depth--;
    else if (depth === 1 && token.startsWith('"') && JSON.parse(token) === "defaultProfile") {
      const next = tokens.slice(i + 1).filter((part) => !part.startsWith("/"));
      if (next[0] === ":" && next[1]?.startsWith('"')) return JSON.parse(next[1]) || undefined;
    }
  }
  return undefined;
}

export function windowsTerminalProfile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WT_PROFILE_ID) return env.WT_PROFILE_ID;
  if (env.LOCALAPPDATA) {
    for (const relative of [
      "Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json",
      "Microsoft/Windows Terminal/settings.json",
      "Packages/Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe/LocalState/settings.json",
    ]) {
      const path = join(env.LOCALAPPDATA, relative);
      let text: string;
      try { text = readFileSync(path, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const profile = defaultProfile(text);
      if (profile) return profile;
      throw Error(`Cannot read defaultProfile from ${path}; launch Tide from your preferred Windows Terminal profile, or use tide launch without --attach`);
    }
  }
  throw Error("Cannot locate Windows Terminal settings; launch Tide from your preferred Windows Terminal profile, or use tide launch without --attach");
}
