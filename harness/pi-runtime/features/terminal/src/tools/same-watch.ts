import type { LiveCommandWatch } from "../monitor-registry.ts";

/** A live watch running the same command, cwd, filter and persistence would deliver the same events. */
export function findSameWatch(
	watches: readonly LiveCommandWatch[],
	request: {
		readonly command: string;
		readonly cwd: string;
		readonly filter: RegExp | undefined;
		readonly persistent: boolean;
	},
): LiveCommandWatch | undefined {
	return watches.find(
		(watch) =>
			!watch.runtime.exited &&
			watch.runtime.spawned?.command === request.command &&
			watch.runtime.spawned.cwd === request.cwd &&
			watch.filter?.source === request.filter?.source &&
			watch.persistent === request.persistent,
	);
}
