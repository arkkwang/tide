import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../session/types.js";

// Profile-driven session launcher config. The config lives at
// `${TIDE_STATE_DIR}/launch-profiles.json` (overridable via TIDE_LAUNCH_PROFILES)
// and owns its own format. Each profile binds a label to a set of env vars,
// an ordered list of shell commands (commands) to run after env is set, and
// an optional description. Labels are case-insensitive and must match
// [a-zA-Z0-9_-]+; lookup is by label only.

export interface ProfileEntry {
  index: number;
  label: string;
  description: string;
  env: Record<string, string>;
  commands: string[][]; // each command is argv (already tokenized)
}

export interface LoadedProfiles {
  path: string;
  profiles: ProfileEntry[];
}

const LABEL_REGEX = /^[a-zA-Z0-9_-]+$/;

export function resolveProfilePath(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.TIDE_LAUNCH_PROFILES ?? join(stateDir, "launch-profiles.json");
}

export function loadProfiles(stateDir: string, env: NodeJS.ProcessEnv = process.env): LoadedProfiles {
  const path = resolveProfilePath(stateDir, env);
  if (!existsSync(path)) {
    throw new Error(
      `Profile config not found: ${path}\n` +
      `Set TIDE_LAUNCH_PROFILES=<path> or create ${path} with shape:\n` +
      `  { "profiles": [ { "label": "minimax", "description": "...", "env": { "ANTHROPIC_AUTH_TOKEN": "..." }, "commands": ["claude --dangerously-skip-permissions"] } ] }\n` +
      `label must match [a-zA-Z0-9_-]+; commands is a non-empty array of single-line shell commands run after env is set.`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Profile config is not valid JSON (${path}): ${errorMessage(error)}`);
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { profiles?: unknown }).profiles)) {
    throw new Error(`Profile config ${path} must be { "profiles": [...] }`);
  }
  const seen = new Set<string>();
  const profiles: ProfileEntry[] = [];
  const list = (raw as { profiles: unknown[] }).profiles;
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    const position = i + 1;
    if (!entry || typeof entry !== "object") throw new Error(`Profile #${position} must be an object`);
    const e = entry as Record<string, unknown>;
    if (typeof e.label !== "string" || !LABEL_REGEX.test(e.label)) {
      throw new Error(`Profile #${position} has invalid label ${JSON.stringify(e.label)} (must match [a-zA-Z0-9_-]+)`);
    }
    const label = e.label;
    if (seen.has(label.toLowerCase())) throw new Error(`Profile label "${label}" is duplicated (labels are case-insensitive)`);
    seen.add(label.toLowerCase());
    const description = typeof e.description === "string" ? e.description : "";
    const commandsRaw = Array.isArray(e.commands) && e.commands.every((x) => typeof x === "string")
      ? e.commands as string[]
      : [];
    if (commandsRaw.length === 0) throw new Error(`Profile "${label}" needs a non-empty "commands" array (each entry is one shell command line)`);
    const commands = commandsRaw.map((line, i) => {
      const tokens = tokenizeCommand(line);
      if (tokens.length === 0) throw new Error(`Profile "${label}" commands[${i}] is empty after parsing`);
      return tokens;
    });
    const env: Record<string, string> = {};
    if (e.env !== undefined) {
      if (!e.env || typeof e.env !== "object" || Array.isArray(e.env)) {
        throw new Error(`Profile "${label}" env must be a string-to-string object`);
      }
      for (const [key, value] of Object.entries(e.env as Record<string, unknown>)) {
        if (typeof value !== "string") throw new Error(`Profile "${label}" env.${key} must be a string`);
        env[key] = value;
      }
    }
    profiles.push({ index: position, label, description, env, commands });
  }
  return { path, profiles };
}

export function findProfile(profiles: ProfileEntry[], label: string): ProfileEntry | null {
  if (!LABEL_REGEX.test(label)) return null;
  const lower = label.toLowerCase();
  return profiles.find((p) => p.label.toLowerCase() === lower) ?? null;
}

// POSIX-safe single-quote wrapping: a single-quoted string cannot contain a
// single quote, so we close, insert an escaped literal quote ('\''), then reopen.
function shellQuote(input: string): string {
  return `'${input.replace(/'/g, `'\\''`)}'`;
}

const NEEDS_QUOTING = /[^A-Za-z0-9_.\-+=@:/]/;

// Minimal shell-style tokenizer: splits on whitespace while respecting single
// and double quotes, so users can write `command: "codex -c 'foo bar'"` and
// have it land as ["codex", "-c", "foo bar"]. No backslash escapes; quoted
// spans are otherwise literal. Empty result means the input was all whitespace.
export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (inSingle) {
      if (c === "'") inSingle = false;
      else current += c;
    } else if (inDouble) {
      if (c === '"') inDouble = false;
      else current += c;
    } else if (c === "'") inSingle = true;
    else if (c === '"') inDouble = true;
    else if (/\s/.test(c)) {
      if (current) { tokens.push(current); current = ""; }
    } else current += c;
  }
  if (current) tokens.push(current);
  return tokens;
}

export function buildLaunchShellCommand(
  profile: ProfileEntry,
  profilesForKeys: Iterable<ProfileEntry>,
  extraArgs: string[] = [],
  cwd?: string,
): string {
  // Atomic swap: unset every key any profile might set, then export only the
  // chosen profile's values. This prevents stale env from a previous profile.
  const seen = new Set<string>();
  for (const p of profilesForKeys) for (const key of Object.keys(p.env)) seen.add(key);
  const parts: string[] = [];
  for (const key of seen) parts.push(`unset ${key}`);
  for (const [key, value] of Object.entries(profile.env)) parts.push(`export ${key}=${shellQuote(value)}`);
  if (cwd) parts.push(`cd ${shellQuote(cwd)}`);
  // Each command is argv; append extraArgs (from `tide launch --profile X -- <args>`)
  // onto the LAST command so users can still inject flags at the call boundary.
  const cmds = profile.commands.map((argv) => argv.map((t) => NEEDS_QUOTING.test(t) ? shellQuote(t) : t));
  if (extraArgs.length && cmds.length) {
    const last = cmds[cmds.length - 1]!;
    cmds[cmds.length - 1] = [...last, ...extraArgs];
  }
  for (const tokens of cmds) parts.push(tokens.join(" "));
  return parts.join("; ");
}