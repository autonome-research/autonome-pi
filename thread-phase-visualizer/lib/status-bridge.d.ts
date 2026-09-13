export type WorkflowStatusSourceV1 =
  | { state: "current" }
  | { state: "unknown"; reason: "initializing" | "store-read-failed" };

export type WorkflowStatusSnapshotV1 = {
  schema: "autonome.workflow-status.snapshot/v1";
  version: 1;
  scopeId: `s1_${string}`;
  publisher: { id: `p1_${string}`; startedAt: string };
  revision: number;
  changedAt: string;
  source: WorkflowStatusSourceV1;
  policy: { recentTerminalMs: 60000; sourceFreshMs: 30000 };
  observation: {
    kind: "bounded-tail";
    indexEventLimit: 8000;
    runLimit: 256;
    itemLimit: 64;
    observedRuns: number;
    itemsTruncated: boolean;
  };
  counts: {
    running: number;
    unknownActive: number;
    successRecent: number;
    failureRecent: number;
    cancelledRecent: number;
    unknownTerminalRecent: number;
  };
  latestTerminal?: {
    workflowId: `w1_${string}`;
    outcome: "success" | "failure" | "cancelled" | "unknown";
    at: string;
    recent: boolean;
  };
  workflows: Array<
    | { id: `w1_${string}`; state: "running" | "unknown" }
    | { id: `w1_${string}`; state: "success" | "failure" | "cancelled" | "unknown-terminal"; terminalAt: string }
  >;
};

export type WorkflowStatusLeaseV1 = {
  schema: "autonome.workflow-status.lease/v1";
  version: 1;
  scopeId: `s1_${string}`;
  publisherId: `p1_${string}`;
  publisherStartedAt: string;
  leaseRevision: number;
  snapshotRevision: number;
  renewedAt: string;
  expiresAt: string;
  sourceObservedAt?: string;
};

export const STATUS_BRIDGE_SCHEMA: "autonome.workflow-status.snapshot/v1";
export const STATUS_BRIDGE_LEASE_SCHEMA: "autonome.workflow-status.lease/v1";
export const STATUS_BRIDGE_RECENT_TERMINAL_MS: 60000;
export const STATUS_BRIDGE_LEASE_RENEW_MS: 15000;
export const STATUS_BRIDGE_LEASE_TTL_MS: 45000;
export const STATUS_BRIDGE_SOURCE_FRESH_MS: 30000;
export const STATUS_BRIDGE_INDEX_EVENT_LIMIT: 8000;
export const STATUS_BRIDGE_RUN_LIMIT: 256;
export const STATUS_BRIDGE_ITEM_LIMIT: 64;
export const STATUS_BRIDGE_PUBLISHER_LIMIT: 256;
export const STATUS_BRIDGE_SNAPSHOT_MAX_BYTES: 16384;
export const STATUS_BRIDGE_LEASE_MAX_BYTES: 2048;
export const STATUS_BRIDGE_FUTURE_SKEW_MS: 5000;

export function deriveStatusBridgeScopeId(sessionId: string): `s1_${string}`;
export function deriveStatusBridgeWorkflowId(sessionId: string, rawRunId: string): `w1_${string}`;
export function statusBridgeRootFromEnv(env?: Record<string, string | undefined>): string | undefined;
export function statusBridgeConfiguration(env?: Record<string, string | undefined>): { root: string } | undefined;
export function projectWorkflowStatusV1(runs: unknown[], options: {
  sessionId: string;
  nowMs?: number;
  normalizeStatus?: (status: unknown) => string;
}): Omit<WorkflowStatusSnapshotV1, "schema" | "version" | "scopeId" | "publisher" | "revision" | "changedAt">;

export type StatusBridgePublisher = {
  root: string;
  scopeId: `s1_${string}`;
  publisherId: `p1_${string}`;
  startedAt: string;
  paths: {
    scopeDirectory: string;
    publishersDirectory: string;
    publisherDirectory: string;
    snapshotFile: string;
    leaseFile: string;
  };
  observe(runs: unknown[]): WorkflowStatusSnapshotV1;
  markUnknown(reason?: "initializing" | "store-read-failed"): WorkflowStatusSnapshotV1;
  renew(): WorkflowStatusLeaseV1;
  currentSnapshot(): WorkflowStatusSnapshotV1;
  close(): void;
};

export function createStatusBridgePublisher(options: {
  root: string;
  sessionId: string;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  autoRenew?: boolean;
  normalizeStatus?: (status: unknown) => string;
}): StatusBridgePublisher;

export type StatusBridgeReadResult =
  | { state: "current"; snapshot: WorkflowStatusSnapshotV1; lease: WorkflowStatusLeaseV1 }
  | { state: "unknown"; reason: string };

export function createStatusBridgeReader(options: {
  root: string;
  sessionId?: string;
  scopeId?: `s1_${string}`;
  now?: () => number;
}): { scopeId: `s1_${string}`; read(): StatusBridgeReadResult };
