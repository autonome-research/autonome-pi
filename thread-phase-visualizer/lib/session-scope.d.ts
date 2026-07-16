import type { ThreadPhaseRunSummary } from "./store.mjs";

type RunLike = Partial<ThreadPhaseRunSummary> & Record<string, any>;

export function canonicalCwd(value?: string, base?: string): string | undefined;
export function sameCanonicalCwd(left?: string, right?: string, base?: string): boolean;
export function matchesRunCwd(run: RunLike, cwd?: string, base?: string): boolean;
export function runSessionId(run?: RunLike): string | undefined;
export function isRunningRun(run?: RunLike, runningStatus?: string): boolean;
export function canInspectRun(run: RunLike, sessionId?: string, fallbackCwd?: string, runningStatus?: string): boolean;
export function mergeMonitorRuns(runs: RunLike[], cwd: string, sessionId?: string, runningStatus?: string): RunLike[];
export function parseCdTargets(command: string): string[];
export function createCwdState(initialCwd?: string): { activeCwd: string; previousCwd: string };
export function trackCwdCommand(
  state: { activeCwd: string; previousCwd: string },
  command: string,
  eventCwd?: string,
): { activeCwd: string; previousCwd: string };
