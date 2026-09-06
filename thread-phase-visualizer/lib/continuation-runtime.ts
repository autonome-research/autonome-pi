import { importFresh } from "./import-fresh.mjs";

// Pi reloads this TypeScript bridge, but Node can retain the unversioned .mjs
// store from the previous extension runtime. Resolve the current implementation
// before the entrypoint registers handlers, rather than mixing API generations.
const store: typeof import("./continuation-store.mjs") = await importFresh(
  new URL("./continuation-store.mjs", import.meta.url),
);

export const {
  continuationClaimIsOwned,
  continuationEligibility,
  createContinuationClaimantId,
  currentProcessStartIdentity,
  discardPendingContinuation,
  loadContinuedRuns,
  loadPendingContinuationRecords,
  markContinuationDelivered,
  persistContinuationClaim,
  relinquishContinuationClaim,
  relinquishContinuationClaims,
  shouldAutoContinue,
} = store;
