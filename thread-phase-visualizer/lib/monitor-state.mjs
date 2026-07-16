export const MONITOR_STATUS_FILTERS = Object.freeze([
  "all",
  "running",
  "success",
  "failed",
  "cancelled",
  "skipped",
  "unknown",
]);

export const MONITOR_SORTS = Object.freeze(["status", "updated", "workflow"]);

const STATUS_ORDER = new Map([
  ["running", 0],
  ["failed", 1],
  ["cancelled", 2],
  ["unknown", 3],
  ["success", 4],
  ["skipped", 5],
]);

function normalizedText(value) {
  return String(value ?? "").toLocaleLowerCase();
}

export function runMatchesSearch(run, query) {
  const needle = normalizedText(query).trim();
  if (!needle) return true;
  return [run?.workflow, run?.runId, run?.normalizedStatus || run?.status, run?.cwd]
    .some((value) => normalizedText(value).includes(needle));
}

export function filterAndSortMonitorRuns(runs, { query = "", status = "all", sort = "status", hideStale = false } = {}) {
  const statusFilter = normalizedText(status) || "all";
  const visible = (runs || []).filter((run) => {
    const runStatus = normalizedText(run?.normalizedStatus || run?.status || "unknown");
    return (!hideStale || !run?.stale) && (statusFilter === "all" || runStatus === statusFilter) && runMatchesSearch(run, query);
  });

  return visible.sort((a, b) => {
    if (sort === "workflow") {
      const workflowOrder = String(a?.workflow || "").localeCompare(String(b?.workflow || ""), undefined, { sensitivity: "base" });
      if (workflowOrder) return workflowOrder;
    } else if (sort === "updated") {
      const updatedOrder = String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || ""));
      if (updatedOrder) return updatedOrder;
    } else {
      const aStatus = normalizedText(a?.normalizedStatus || a?.status || "unknown");
      const bStatus = normalizedText(b?.normalizedStatus || b?.status || "unknown");
      const statusOrder = (STATUS_ORDER.get(aStatus) ?? 99) - (STATUS_ORDER.get(bStatus) ?? 99);
      if (statusOrder) return statusOrder;
    }
    const updatedOrder = String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || ""));
    if (updatedOrder) return updatedOrder;
    return String(a?.workflow || "").localeCompare(String(b?.workflow || ""), undefined, { sensitivity: "base" });
  });
}

export function cycleMonitorOption(current, options) {
  const index = options.indexOf(current);
  return options[(index + 1 + options.length) % options.length];
}
