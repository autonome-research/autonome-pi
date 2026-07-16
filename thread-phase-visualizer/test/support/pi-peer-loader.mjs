const STUBS = {
  "typebox": `
    export const Type = new Proxy({}, { get() { return () => ({}); } });
  `,
  "@earendil-works/pi-coding-agent": `
    export function getMarkdownTheme() { return {}; }
    export function keyHint(_key, label) { return label; }
  `,
  "@earendil-works/pi-tui": `
    export const Key = {
      escape: "\\x1b",
      enter: "\\r",
      left: "\\x1b[D",
      right: "\\x1b[C",
      up: "\\x1b[A",
      down: "\\x1b[B",
      ctrl(key) { return String.fromCharCode(key.toLowerCase().charCodeAt(0) - 96); },
    };
    export function matchesKey(data, key) { return data === key; }
    export function visibleWidth(value) { return [...String(value)].length; }
    export function truncateToWidth(value, width, ellipsis = "…") {
      const chars = [...String(value)];
      if (chars.length <= width) return String(value);
      const suffix = [...ellipsis];
      return chars.slice(0, Math.max(0, width - suffix.length)).join("") + suffix.join("");
    }
    export class Markdown {
      constructor(content) { this.content = content; }
      render() { return String(this.content).split(/\\r?\\n/); }
    }
    export class Container {
      constructor() { this.children = []; }
      addChild(child) { this.children.push(child); }
    }
    export class Box {
      constructor() { this.children = []; }
      addChild(child) { this.children.push(child); }
    }
    export class Spacer { constructor(lines = 1) { this.lines = lines; } }
    export class Text { constructor(text) { this.text = String(text); } }
  `,
};

export function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(STUBS, specifier)) return { url: `pi-test-stub:${specifier}`, shortCircuit: true };
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url.startsWith("pi-test-stub:")) {
    const specifier = url.slice("pi-test-stub:".length);
    return { format: "module", source: STUBS[specifier], shortCircuit: true };
  }
  return nextLoad(url, context);
}
