import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { StatusBridgeReadResult } from "../../thread-phase-visualizer/lib/status-bridge.mjs";

export const ACTIVE_SYMBOL: "⚙︎";
export const ATTENTION_SYMBOL: "⎊";
export const COMPLETED_SYMBOL: "⌘";
export const TERMINAL_TITLE_POLL_MS: 5000;
export const TERMINAL_TITLE_HANDOFF_MS: 100;
export const TERMINAL_TITLE_COMPONENT_MAX_BYTES: 96;
export const TERMINAL_TITLE_MAX_BYTES: 240;
export type TerminalTitleState = "attention" | "active" | "completed" | "idle";
export function sanitizeTitleComponent(value: unknown, maxBytes?: number): string;
export function projectTerminalTitleState(result: StatusBridgeReadResult | unknown): TerminalTitleState;
export function terminalTitlePrefix(state: TerminalTitleState): string;
export function buildTerminalTitle(options: { state: TerminalTitleState; sessionName?: unknown; cwd?: unknown }): string;
export function registerThreadPhaseTerminalTitle(pi: ExtensionAPI, options?: Record<string, unknown>): void;
