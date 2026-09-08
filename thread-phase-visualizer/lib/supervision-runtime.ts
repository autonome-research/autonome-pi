import { importFresh } from "./import-fresh.mjs";

// Reload both native modules explicitly. Freshening one module does not refresh
// its transitive native imports, so the supervision helpers intentionally do not
// import each other.
const [store, message]: [
	typeof import("./supervision-store.mjs"),
	typeof import("./supervision-message.mjs"),
] = await Promise.all([
	importFresh(new URL("./supervision-store.mjs", import.meta.url)),
	importFresh(new URL("./supervision-message.mjs", import.meta.url)),
]);

export const {
	DEFAULT_PROGRESS_REVIEW_CADENCE_MS,
	acknowledgeProgressReview,
	claimProgressReview,
	createProgressReviewClaimantId,
	deferProgressReview,
	discardProgressReview,
	ensureProgressReview,
	loadProgressReviewRecords,
	progressReviewClaimIsOwned,
	relinquishProgressReviewClaim,
	relinquishProgressReviewClaims,
} = store;

export const {
	formatProgressReviewPrompt,
	sessionHistoryHasProgressReview,
} = message;
