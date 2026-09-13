import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerThreadPhaseTerminalTitle } from "./lib/terminal-title.mjs";

export default function threadPhaseTerminalTitle(pi: ExtensionAPI) {
	registerThreadPhaseTerminalTitle(pi);
}
