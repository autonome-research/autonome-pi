import type { ChildProcess } from "node:child_process";

export const DEFAULT_CAPTURE_BYTES: number;
export const DEFAULT_KILL_GRACE_MS: number;
export const MAX_TIMEOUT_MS: number;

export interface BoundedProcessCommonOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  signal?: AbortSignal;
  killGraceMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  stdoutKeep?: "head" | "tail";
  stderrKeep?: "head" | "tail";
  captureStdout?: boolean;
  captureStderr?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Internal trusted source lifetime, independent of optional display/capture.
   * close runs at actual stdout closure, before result; false means lost input.
   * No hook is called when no stream was created. Never from caller/worker JSON.
   */
  stdoutSource?: { push(chunk: string): void; close(complete: boolean): void };
  onNoChild?: () => void;
  onChildStart?: (child: ChildProcess) => void;
  onChildEnd?: (child: ChildProcess) => void;
  /** Internal trusted executor hook; never populate from worker/caller JSON. */
  lifecycle?: {
    attach(child: ChildProcess, abandon: () => void): void;
    dispatch(): void;
    terminate(signal: NodeJS.Signals): void;
    settle(exit: { code: number | null; signal: NodeJS.Signals | null; spawnError?: Error }): Promise<Record<string, unknown>>;
  };
}

export type BoundedProcessOptions = BoundedProcessCommonOptions & (
  | { timeoutMs: number; noDeadline?: false }
  | { timeoutMs?: never; noDeadline: true }
);

export interface BoundedProcessResult {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  termination?: Record<string, unknown>;
  scopeSettlement?: Record<string, unknown>;
  error?: string;
}

export function normalizeTimeoutMs(value: unknown, label?: string): number;
export function terminateChild(child: ChildProcess, signal?: NodeJS.Signals): void;
export function runBoundedProcess(command: string, args: readonly string[], options: BoundedProcessOptions): Promise<BoundedProcessResult>;
