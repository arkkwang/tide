import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionRecord } from "./types.js";

export function stateDirectory(): string {
  if (process.env.TIDE_STATE_DIR) return resolve(process.env.TIDE_STATE_DIR);
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (directory === parent) throw Error("Cannot locate Tide package root; set TIDE_STATE_DIR");
    directory = parent;
  }
  return join(directory, ".tide");
}

export function validateId(id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw Error("Invalid session UUID");
  return id;
}

export class Registry {
  readonly directory: string;
  constructor(readonly state = stateDirectory()) { this.directory = join(state, "sessions"); }
  path(id: string) { return join(this.directory, `${validateId(id)}.json`); }
  write(record: SessionRecord) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(record.id), temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  }
  remove(id: string) {
    try { unlinkSync(this.path(id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  records(): SessionRecord[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).filter((file) => file.endsWith(".json")).flatMap((file) => {
      let content: string;
      try { content = readFileSync(join(this.directory, file), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
      const record = JSON.parse(content) as SessionRecord;
      if (`${validateId(record.id)}.json` !== file || typeof record.endpoint !== "string" || typeof record.token !== "string") throw Error(`Invalid session record: ${file}`);
      return [record];
    });
  }
}

export function resolveSession<T extends { id: string }>(sessions: T[], prefix: string): T {
  if (!prefix || !/^[a-f0-9-]+$/.test(prefix)) throw Error("Session ID must be a UUID or nonempty UUID prefix");
  const exact = sessions.find((session) => session.id === prefix);
  if (exact) return exact;
  const matches = sessions.filter((session) => session.id.startsWith(prefix));
  if (!matches.length) throw Error(`No session matches ${prefix}; use tide list`);
  if (matches.length > 1) throw Error(`Ambiguous session ID ${prefix}; candidates: ${matches.map((s) => s.id).join(", ")}`);
  return matches[0]!;
}
