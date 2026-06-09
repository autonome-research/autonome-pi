import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { safeName } from "../core/text.ts";

export function registryRoot(home = homedir()): string {
	return join(home, ".pi", "agent", "mission-workflow", "registry");
}

export function registrySegmentFor(missionId: string): string {
	const segment = safeName(missionId, "mission");
	return segment === "." || segment === ".." ? "mission" : segment;
}

export function registryDirFor(missionId: string, root = registryRoot()): string {
	const rootPath = resolve(root);
	const dir = resolve(rootPath, registrySegmentFor(missionId));
	const rel = relative(rootPath, dir);
	if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return dir;
	throw new Error(`Unsafe mission registry path for missionId: ${missionId}`);
}

export function registryStatePath(missionId: string, root = registryRoot()): string {
	return join(registryDirFor(missionId, root), "state.json");
}
