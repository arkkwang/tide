import type { CliKind } from "../config.js";

export interface WindowInfo {
  usedPercent: number;
  resetsAt: number | null;
}

export interface QuotaInfo {
  allowed: boolean;
  blockedReason: "window" | "credits" | "rate_limit" | "unknown" | null;
  primary: WindowInfo | null;
  secondary: WindowInfo | null;
  nextResetAt: number | null;
  plan: string | null;
  notes: string[];
}

export interface Utterance {
  text: string;
}

export const SPOKEN_COUNT = 10;
export const SPOKEN_CHARS = 80;

/** Last recorded execution event; not proof of a currently running process. */
export type RecordedEvent =
  | "unknown"
  | "completed"
  | "running"
  | "aborted"
  | "errored"
  | "quota-limited";

export interface Session {
  sessionId: string;
  transcriptPath?: string;
  cwd: string;
  /** Timestamp of the most recent assistant response, in unix ms. An assistant response is
   * anything the model itself produced — a text reply or a tool call — regardless of whether
   * the turn has finished. Adapters must populate this — typically by falling back to the
   * file's mtime when the transcript records no assistant response. */
  lastAssistantAt: number;
  model?: string | null;
  source?: string | null;
  /** Subagent identity is independent of execution state. */
  isSubagent: boolean;
  parentThreadId?: string | null;
  lastEvent: RecordedEvent;
  /** Human prompts, newest first. `lastUserUtterance` reads index 0 as the latest. */
  spoken?: Utterance[];
}

export interface DeliveryResult {
  ok: boolean;
  delivered: boolean;
  via: string;
  detail: string;
  uncertain?: boolean;
  deferred?: boolean;
  unsupported?: boolean;
  launchRequested?: boolean;
}

export interface ExecutionSnapshot {
  sessionId: string;
  cli: CliKind;
  cwd: string;
  observedAt: string;
  currentState: "unknown";
  lastEvent: RecordedEvent;
  messages: TranscriptMessage[];
  truncated: boolean;
}

export interface LaunchReceipt {
  ok: boolean;
  requested: boolean;
  detail: string;
  deferred?: boolean;
}

export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: string | null;
}

export interface TranscriptEvent {
  offset: number;
  message?: TranscriptMessage;
  outcome?: "completed" | "errored" | "quota-limited" | "aborted";
  evidence?: string;
  state?: RecordedEvent;
}

export interface History {
  events: TranscriptEvent[];
  cursor(offset?: number, expected?: string | null): string;
  expected: string | undefined;
}

export interface Adapter {
  readonly kind: CliKind;

  resolveBin(): string | null;

  /** Read quota state. Claude uses a real probe request that consumes quota. */
  readQuota(): Promise<QuotaInfo>;

  /** Historical observations, newest first. Selection belongs to the caller. */
  findSessions(): Promise<Session[]>;

  snapshot(session: Session, limit: number): ExecutionSnapshot;
  history(session: Session, after?: string): History;

  send?(session: Session, prompt: string): Promise<DeliveryResult>;

  /** Bootstrap input belongs to launching; it does not provide a live message channel. */
  launchSession?(session: Session, initialMessage: string): Promise<LaunchReceipt>;

  sessionForProcess?(pid: number): Promise<string | null>;
  ownsIdleProcess?(sessionId: string, pid: number): Promise<boolean>;
  prepareLaunch?(args: string[]): Promise<{ args: string[]; sessionId: string | null }>;
}
