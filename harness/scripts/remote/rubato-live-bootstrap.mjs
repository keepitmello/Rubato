#!/usr/bin/env node
import { runBootstrap } from "../../../packages/rubato-live-cli/src/bootstrap.mjs";

const descriptorPath = process.argv[2];
if (!descriptorPath) {
  console.error("rubato-live-bootstrap: descriptor path is required");
  process.exit(2);
}

try {
  await runBootstrap(descriptorPath);
} catch (error) {
  console.error(`rubato-live-bootstrap: ${error.message}`);
  process.exit(1);
}
