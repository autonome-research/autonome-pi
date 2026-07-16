export const DEFAULT_CONTINUATION_LIMIT: 500;
export const DEFAULT_CONTINUATION_RETENTION_MS: number;
export const CONTINUED_RUNS_FILENAME: "continued-runs.json";
export const CONTINUATION_TIMESTAMPS_FILENAME: "continued-runs.timestamps.json";

export type ContinuationStoreOptions = {
  storeDir: string;
  maxEntries?: number;
  /** Claims older than this duration are discarded. Defaults to 24 hours. */
  maxAgeMs?: number;
  /** Injectable reference clock for deterministic retention tests. */
  now?: number | string | Date;
};

export function shouldAutoContinue(run: {
  normalizedStatus?: string;
  metadata?: { autoContinue?: boolean | string };
} | undefined): boolean;
export function continuedRunsFile(storeDir: string): string;
export function pruneContinuedRuns(runs: Iterable<string> | Set<string>, maxEntries?: number): Set<string>;
export function loadContinuedRuns(options: ContinuationStoreOptions): Set<string>;
export function persistContinuedRuns(runs: Iterable<string> | Set<string>, options: ContinuationStoreOptions): Set<string>;
export function persistContinuationClaim(runId: string, options: ContinuationStoreOptions): {
  claimed: boolean;
  runs: Set<string>;
};
export function releaseContinuationClaim(runId: string, options: ContinuationStoreOptions): {
  released: boolean;
  runs: Set<string>;
};
