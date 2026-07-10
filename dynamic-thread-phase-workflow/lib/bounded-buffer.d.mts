export interface BoundedTextBufferOptions {
  keep?: "head" | "tail";
}

export interface BoundedTextValueOptions {
  marker?: boolean;
}

export class BoundedTextBuffer {
  constructor(maxBytes: number, options?: BoundedTextBufferOptions);
  readonly maxBytes: number;
  readonly keep: "head" | "tail";
  readonly observedBytes: number;
  readonly truncated: boolean;
  append(value: unknown): void;
  value(options?: BoundedTextValueOptions): string;
}

export function takeUtf8Prefix(text: string, maxBytes: number): string;
export function takeUtf8Suffix(text: string, maxBytes: number): string;
