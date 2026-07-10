import type { ChildProcess } from "node:child_process";

export const DEFAULT_CAPTURE_BYTES: number;
export const DEFAULT_KILL_GRACE_MS: number;
export const MAX_TIMEOUT_MS: number;

export interface BoundedProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  signal?: AbortSignal;
  timeoutMs: number;
  killGraceMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  stdoutKeep?: "head" | "tail";
  stderrKeep?: "head" | "tail";
  captureStdout?: boolean;
  captureStderr?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onChildStart?: (child: ChildProcess) => void;
  onChildEnd?: (child: ChildProcess) => void;
}

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
  error?: string;
}

export function normalizeTimeoutMs(value: unknown, label?: string): number;
export function terminateChild(child: ChildProcess, signal?: NodeJS.Signals): void;
export function runBoundedProcess(command: string, args: readonly string[], options: BoundedProcessOptions): Promise<BoundedProcessResult>;
