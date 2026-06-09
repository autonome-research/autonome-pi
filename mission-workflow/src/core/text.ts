import { MAX_TEXT_BYTES } from "./constants.ts";

export function byteLength(text: unknown): number {
	return Buffer.byteLength(String(text || ""), "utf8");
}

export function safeName(value: unknown, fallback = "item", maxChars = 80): string {
	return String(value || fallback).replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, maxChars) || fallback;
}

export function compactText(text: string, maxBytes = MAX_TEXT_BYTES): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const parts: string[] = [];
	let bytes = 0;
	for (const char of text) {
		const charBytes = Buffer.byteLength(char, "utf8");
		if (bytes + charBytes > maxBytes) break;
		parts.push(char);
		bytes += charBytes;
	}
	return `${parts.join("")}\n\n[truncated: original output was ${Buffer.byteLength(text, "utf8")} bytes]`;
}

export function appendBounded(current: string, chunk: string | Buffer, maxBytes = MAX_TEXT_BYTES): string {
	const text = typeof chunk === "string" ? chunk : chunk.toString();
	if (!text || maxBytes <= 0) return current;
	const combined = current ? `${current}${text}` : text;
	if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
	const marker = "[truncated older output]\n";
	const markerBytes = Buffer.byteLength(marker, "utf8");
	const tailBudget = Math.max(0, maxBytes - markerBytes);
	if (tailBudget === 0) return marker.slice(0, maxBytes);
	const tail: string[] = [];
	let bytes = 0;
	const chars = Array.from(combined);
	for (let i = chars.length - 1; i >= 0; i--) {
		const char = chars[i];
		const charBytes = Buffer.byteLength(char, "utf8");
		if (bytes + charBytes > tailBudget) break;
		tail.push(char);
		bytes += charBytes;
	}
	return `${marker}${tail.reverse().join("")}`;
}
