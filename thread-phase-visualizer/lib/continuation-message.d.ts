export const CONTINUATION_MARKER_SCHEMA: "thread-phase-continuation/v1";

export function continuationDeliveryMarker(deliveryId: string): string;
export function formatMarkedContinuation(prompt: string, deliveryId: string): string;

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
