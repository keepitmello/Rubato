#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { importRun } from "./measurement-benchmark-lib.mjs";

function value(argv, flag) {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}
export function main(argv = process.argv.slice(2)) {
  const source = value(argv, "--source");
  const root = value(argv, "--root");
  const environment = value(argv, "--env-label");
  const model = value(argv, "--model");
  const runNumber = Number(value(argv, "--run") ?? 1);
  if (!source || !root || !environment || !Number.isInteger(runNumber) || runNumber < 1) throw new Error("usage: import-measurement-run.mjs --source RUN_DIR --root RESULT_ROOT --env-label LABEL [--model MODEL] [--run N]");
  process.stdout.write(`${importRun(source, root, { runNumber, environment, model })}\n`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
