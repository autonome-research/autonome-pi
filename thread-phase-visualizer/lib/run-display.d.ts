import type { ThreadPhaseRunSummary } from "./store.mjs";

type RunLike = Partial<ThreadPhaseRunSummary> & Record<string, any>;

export function runSessionId(run?: RunLike): string | undefined;
export function belongsToSession(run: RunLike, sessionId?: string, cwd?: string): boolean;
export function runOwnerMetadata(run?: RunLike): { sessionId?: string; launchSource?: string; cwdAtLaunch?: string };
export function formatOwnerMetadata(run?: RunLike): string;
export function formatStaleIndicator(run?: RunLike): string;
export function formatElapsedDuration(startedAt?: string | number | Date, endedAt?: string | number | Date): string;
export function processedTokenTotal(usage?: Record<string, any>): number;
export function formatTotalTokens(usage?: Record<string, any>): string;
export function formatOutputTokens(usage?: Record<string, any>): string;
export function formatTokenSummary(usage?: Record<string, any>): string;
export function formatTokenBreakdown(usage?: Record<string, any>): string[];
