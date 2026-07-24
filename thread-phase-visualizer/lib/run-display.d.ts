import type { ThreadPhaseRunSummary } from "./store.mjs";

type RunLike = Partial<ThreadPhaseRunSummary> & Record<string, any>;

export function runSessionId(run?: RunLike): string | undefined;
export function belongsToSession(run: RunLike, sessionId?: string, cwd?: string): boolean;
export function runOwnerMetadata(run?: RunLike): { sessionId?: string; launchSource?: string; cwdAtLaunch?: string };
export function formatOwnerMetadata(run?: RunLike): string;
export function formatStaleIndicator(run?: RunLike): string;
export function formatElapsedDuration(startedAt?: string | number | Date, endedAt?: string | number | Date): string;
export function formatTotalTokens(usage?: Record<string, any>): string;
