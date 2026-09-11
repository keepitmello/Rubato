import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.85.1";
const featureDir = dirname(fileURLToPath(import.meta.url));

function walk(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? walk(path) : [path];
	});
}

const runtimeSources = [
	join(featureDir, "LICENSE"),
	join(featureDir, "THIRD_PARTY_NOTICES.md"),
	...walk(join(featureDir, "src")),
].sort();

export const patches = Object.freeze([]);
export const files = Object.freeze(
	runtimeSources.map((sourcePath) =>
		Object.freeze({
			target: "runtime",
			version: VERSION,
			path: `rubato-features/terminal/${relative(featureDir, sourcePath).split(sep).join("/")}`,
			sourcePath,
		}),
	),
);

export const feature = Object.freeze({ id: "terminal", patches, files });
