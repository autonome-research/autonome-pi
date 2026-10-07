export const CONTINUATION_MARKER_SCHEMA: "thread-phase-continuation/v1";

export type ContinuationIdentity = { runId?: string; sessionId?: string };
export function continuationDeliveryMarker(deliveryId: string, identity?: ContinuationIdentity): string;
export function formatMarkedContinuation(prompt: string, deliveryId: string, identity?: ContinuationIdentity): string;
export function sessionHistoryHasRunContinuation(entries: readonly ContinuationSessionEntry[] | undefined, runId: string, sessionId?: string): boolean;

export type ContinuationSessionEntry = {
  type?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
  };
  content?: string | Array<{ type?: string; text?: string }>;
  details?: { deliveryId?: string } & Record<string, unknown>;
};

export function sessionHistoryHasContinuation(
  entries: readonly ContinuationSessionEntry[] | undefined,
  deliveryId: string,
): boolean;
