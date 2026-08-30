#!/usr/bin/env node
import { spawnRubatoPi } from "../src/launch.mjs";

const child = await spawnRubatoPi();
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
