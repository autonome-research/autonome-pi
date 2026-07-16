export type MonitorSort = "status" | "updated" | "workflow";
export type MonitorStatusFilter = "all" | "running" | "success" | "failed" | "cancelled" | "skipped" | "unknown";

export const MONITOR_STATUS_FILTERS: readonly MonitorStatusFilter[];
export const MONITOR_SORTS: readonly MonitorSort[];

export function runMatchesSearch(run: Record<string, unknown>, query: string): boolean;
export function filterAndSortMonitorRuns<T extends Record<string, any>>(
  runs: T[],
  options?: { query?: string; status?: MonitorStatusFilter | string; sort?: MonitorSort | string; hideStale?: boolean },
): T[];
export function cycleMonitorOption<T>(current: T, options: readonly T[]): T;
