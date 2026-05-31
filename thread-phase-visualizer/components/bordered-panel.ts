import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type BorderColor = "border" | "borderAccent" | "borderMuted" | "accent" | "muted" | "dim";

export type BorderedPanelOptions = {
	title?: string;
	borderColor?: BorderColor;
	titleColor?: BorderColor;
};

function padVisible(text: string, targetWidth: number): string {
	const width = visibleWidth(text);
	return text + " ".repeat(Math.max(0, targetWidth - width));
}

function fitVisible(text: string, targetWidth: number): string {
	return padVisible(truncateToWidth(text, targetWidth, ""), targetWidth);
}

export function framePanel(lines: string[], width: number, theme: any, options: BorderedPanelOptions = {}): string[] {
	const panelWidth = Math.max(8, width);
	const innerWidth = Math.max(0, panelWidth - 4); // border + space on each side
	const borderColor = options.borderColor || "borderAccent";
	const titleColor = options.titleColor || "accent";
	const border = (s: string) => theme.fg(borderColor, s);
	const titleText = options.title ? ` ${options.title} ` : "";
	const fittedTitle = truncateToWidth(titleText, Math.max(0, innerWidth), "");
	const titleVisible = visibleWidth(fittedTitle);
	const remaining = Math.max(0, innerWidth - titleVisible);
	const left = Math.floor(remaining / 2);
	const right = remaining - left;

	const top = [
		border("╭"),
		border("─".repeat(left)),
		fittedTitle ? theme.fg(titleColor, theme.bold(fittedTitle)) : "",
		border("─".repeat(right)),
		border("╮"),
	].join("");
	const bottom = `${border("╰")}${border("─".repeat(innerWidth))}${border("╯")}`;
	const body = lines.map((line) => `${border("│")} ${fitVisible(line, innerWidth)} ${border("│")}`);
	return [top, ...body, bottom];
}
