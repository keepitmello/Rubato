#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { aggregateRoot, compareRoots } from "./measurement-benchmark-lib.mjs";

export function main(argv = process.argv.slice(2)) {
  if (argv.length < 1 || argv.length > 2) throw new Error("usage: aggregate-measurement-benchmarks.mjs RESULT_ROOT [COMPARE_ROOT]");
  const result = argv[1] ? compareRoots(argv[0], argv[1]) : aggregateRoot(argv[0]);
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (!argv[1]) writeFileSync(`${argv[0]}/aggregate.json`, output);
  process.stdout.write(output);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
