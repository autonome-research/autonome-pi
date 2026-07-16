export const DEFAULT_CONTINUATION_LIMIT: 500;
export const DEFAULT_PENDING_CONTINUATION_LIMIT: 500;
export const DEFAULT_CONTINUATION_CLAIM_LEASE_MS: number;
export const DEFAULT_CONTINUATION_RETENTION_MS: number;
export const CONTINUED_RUNS_FILENAME: "continued-runs.json";
export const CONTINUATION_TIMESTAMPS_FILENAME: "continued-runs.timestamps.json";
export const CONTINUATION_STATE_FILENAME: "continuations.json";
export const CONTINUATION_STATE_SCHEMA: "thread-phase-continuations/v3";

export type ContinuationStoreOptions = {
  storeDir: string;
  maxEntries?: number;
  /** Maximum retained pending records. New claims fail once this bound is reached. */
  maxPendingEntries?: number;
  /** Maximum claimant lease before retry may reclaim a still-live PID. Defaults to 30 minutes. */
  claimLeaseMs?: number;
  /** Delivered history older than this duration is discarded; pending work is retained. Defaults to 24 hours. */
  maxAgeMs?: number;
  /** Injectable reference clock for deterministic retention tests. */
  now?: number | string | Date;
};

export type ContinuationClaimOptions = ContinuationStoreOptions & {
  /** Reclaim a pending record when its claimant is absent, this claimant, or no longer active. */
  retryPending?: boolean;
  claimantId?: string;
  claimantProcessStart?: string;
};

export type ContinuationRecord = {
  runId: string;
  deliveryId: string;
  state: "pending" | "delivered";
  continuedAt: string;
  claimantPid?: number;
  claimantId?: string;
  claimantProcessStart?: string;
  claimantLeaseUntil?: string;
};

export function shouldAutoContinue(run: {
  normalizedStatus?: string;
  metadata?: { autoContinue?: boolean | string };
} | undefined): boolean;
export function continuedRunsFile(storeDir: string): string;
export function pruneContinuedRuns(runs: Iterable<string> | Set<string>, maxEntries?: number): Set<string>;
export function loadContinuedRuns(options: ContinuationStoreOptions): Set<string>;
export function loadPendingContinuations(options: ContinuationStoreOptions): Set<string>;
export function loadPendingContinuationRecords(options: ContinuationStoreOptions): ContinuationRecord[];
export function createContinuationClaimantId(): string;
export function currentProcessStartIdentity(): string | undefined;
export function persistContinuedRuns(runs: Iterable<string> | Set<string>, options: ContinuationStoreOptions): Set<string>;
export function persistContinuationClaim(runId: string, options: ContinuationClaimOptions): {
  claimed: boolean;
  state?: "pending" | "delivered";
  deliveryId?: string;
  runs: Set<string>;
};
export function markContinuationDelivered(runId: string, options: ContinuationStoreOptions & { deliveryId?: string }): {
  delivered: boolean;
  runs: Set<string>;
};
export function relinquishContinuationClaims(options: ContinuationStoreOptions & {
  claimantId?: string;
  claimantPid?: number;
  claimantProcessStart?: string;
}): {
  relinquished: number;
  runs: Set<string>;
};
/** @deprecated Normal delivery failures remain pending for startup retry. */
export function releaseContinuationClaim(runId: string, options: ContinuationStoreOptions): {
  released: boolean;
  runs: Set<string>;
};
