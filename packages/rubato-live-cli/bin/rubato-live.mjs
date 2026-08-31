#!/usr/bin/env node
import { runCli } from "../src/cli.mjs";

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  console.error(`rubato: ${error.message}`);
  process.exitCode = error?.code === "HUB_UNAVAILABLE" || error?.code === "ENOENT" ? 75 : 1;
}
