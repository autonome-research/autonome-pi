import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Keep this tiny bridge in native ESM: Jiti rewrites import() in TypeScript and
 * strips URL queries on that path. Native import preserves the content revision,
 * bypassing stale Node ESM entries without leaking a new module on every reload.
 * This refreshes the requested module, not its transitive imports.
 */
export function importFresh(moduleUrl) {
  const url = new URL(moduleUrl);
  if (url.protocol !== "file:") throw new Error("Fresh extension imports require a local file URL");
  url.searchParams.set("revision", createHash("sha256").update(readFileSync(url)).digest("hex"));
  return import(url.href);
}
