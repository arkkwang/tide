export interface SessionInfo {
  id: string;
  pid: number;
  shellPid: number;
  shell: string;
  cwd: string;
  createdAt: string;
  exited: boolean;
  exitCode: number | null;
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
}

export interface ShellOptions {
  shell?: string;
  args?: string[];
  cwd?: string;
}

export interface IdleResult { id: string; idle: boolean; elapsedMs: number; idleForMs: number }

export type Request =
  | { command: "info" | "close" | "plugins" }
  | { command: "capture"; lines?: number }
  | { command: "wait-idle"; idleTime: number; timeout: number }
  | { command: "send"; text: string }
  | { command: "send-key"; keys: string[] }
  | { command: "plugin"; plugin: string; action: string; args: string[] };

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
