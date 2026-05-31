import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { readArtifactContent } from "../lib/store.mjs";

type Artifact = Record<string, any>;
type RunSummary = Record<string, any>;

const MAX_ARTIFACT_BYTES = 80_000;

export function artifactSummaryText(run: RunSummary): string {
	const artifacts: Artifact[] = run.artifacts || [];
	if (artifacts.length === 0) return "0 artifacts";
	return `${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}`;
}

export function renderArtifactList(run: RunSummary, theme: Theme, expanded: boolean, options: { contentMode?: "none" | "summary" | "all" } = {}) {
	const artifacts: Artifact[] = run.artifacts || [];
	const contentMode = options.contentMode ?? "none";
	const container = new Container();
	if (artifacts.length === 0) {
		container.addChild(new Text(theme.fg("dim", "No artifacts"), 0, 0));
		return container;
	}

	for (const artifact of artifacts) {
		const title = artifact.title || artifact.kind || "artifact";
		const target = artifact.path || artifact.preview || (artifact.content ? "(inline)" : "");
		container.addChild(new Text(`${theme.fg("success", "◉")} ${theme.fg("accent", title)}${target ? theme.fg("dim", ` — ${target}`) : ""}`, 0, 0));
		const isSummary = /summary/i.test(String(title));
		const shouldRenderContent = expanded && (contentMode === "all" || (contentMode === "summary" && isSummary));
		if (shouldRenderContent) {
			const rendered = renderArtifactContent(artifact, theme);
			if (rendered) {
				container.addChild(new Spacer(1));
				container.addChild(rendered);
			}
		}
	}
	return container;
}

export function renderArtifactContent(artifact: Artifact, theme: Theme) {
	let content: string | undefined;
	let truncated = false;
	try {
		const result = readArtifactContent(artifact, { maxBytes: MAX_ARTIFACT_BYTES });
		content = result?.content;
		truncated = Boolean(result?.truncated);
	} catch (error: any) {
		return new Text(theme.fg("error", `Could not read artifact: ${error?.message || error}`), 0, 0);
	}
	if (!content) return undefined;

	const suffix = truncated ? "\n\n[artifact truncated]" : "";
	const kind = String(artifact.kind || "").toLowerCase();
	if (kind === "markdown" || artifact.path?.endsWith?.(".md")) {
		return new Markdown(`${content}${suffix}`, 0, 0, getMarkdownTheme());
	}
	return new Text(theme.fg("toolOutput", `${content}${suffix}`), 0, 0);
}
