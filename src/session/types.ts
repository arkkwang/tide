export interface SessionInfo {
  id: string;
  pid: number;
  shellPid: number;
  shell: string;
  cwd: string;
  createdAt: string;
  exited: boolean;
  exitCode: number | null;
  idleForMs?: number;
  lastOutputAt?: string | null;
  display?: "detached" | "opening" | "attached";
}

export interface SessionRecord extends SessionInfo {
  endpoint: string;
  token: string;
}

export interface Snapshot {
  id: string;
  capturedAt: string;
  cols: number;
  rows: number;
  buffer: "normal" | "alternate";
  title: string;
  text: string;
  cursor?: { row: number; col: number };
}

export interface ShellOptions {
  shell?: string;
  args?: string[];
  cwd?: string;
}

export interface IdleResult { id: string; idle: boolean; elapsedMs: number; idleForMs: number }

export type Request =
  | { command: "info" | "close" | "plugins" }
  | { command: "attach-reserve" }
  | { command: "attach-status" | "attach-cancel"; ticket: string }
  | { command: "read"; lines?: number; full?: boolean }
  | { command: "wait-idle"; idleTime: number; timeout: number }
  | ({ command: "send" } & ({ text: string; keys?: never } | { keys: string[]; text?: never }))
  | { command: "scroll"; direction: "up" | "down"; steps: number; x?: number; y?: number }
  | { command: "resize"; cols: number; rows: number }
  | { command: "plugin"; plugin: string; action: string; args: string[] };

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
