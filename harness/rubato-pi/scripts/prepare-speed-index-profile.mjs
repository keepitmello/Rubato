#!/usr/bin/env node
/** Reference-only registration. No model calls, uploads, or implicit activation. */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readSpeedLogs } from "./analyze-speed-index.mjs";
import { prepareSpeedV2Profile, SPEED_V2_PROFILE_FILE, SPEED_V2_REFERENCE, validateSpeedV2Profile } from "../src/speed-index-v2.mjs";
import { resolveSpeedIndexAgentDir, writeBaselineExclusive } from "../src/speed-index-store.mjs";

const HELP = `Usage: node scripts/prepare-speed-index-profile.mjs [samples-dir|file.jsonl[.gz] ...]
  --from ISO             Reference-window start
  --to ISO               Reference-window end (exclusive)
  --reference-tier KEY   Exact observed Sol request/service tier key
  --id ID                Stable profile name (default: delivery-basket-v2)
  --output FILE          Write the ready profile once; never overwrite

Default: read-only JSON proposal. Missing reference components or time blocks
produce unavailable, never a partial basket. No artificial Sol calls are made.
For a live local profile, use only this machine's raw logs, then explicitly
write <agent-dir>/speed-index/profile-v2.json and restart the session.
Profiles containing pseudonymous devices are for offline comparison, not local
activation. Registration freezes reference times, conditions, and weights.`;

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) { process.stdout.write(`${HELP}\n`); return; }
  const args = {};
  const paths = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--from", "--to", "--reference-tier", "--id", "--output"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
      args[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    else paths.push(arg);
  }
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const agentDir = resolveSpeedIndexAgentDir(process.env, home) ?? join(home, ".rubato-pi", "agent");
  const input = readSpeedLogs(paths.length ? paths : [join(agentDir, "speed-index", "samples")]);
  const prepared = prepareSpeedV2Profile(input.rows, {
    ...(args.from ? { from: Date.parse(args.from) } : {}),
    ...(args.to ? { to: Date.parse(args.to) } : {}),
    ...(args.id ? { id: args.id } : {}),
    reference: { ...SPEED_V2_REFERENCE, ...(args["reference-tier"] ? { tierKey: args["reference-tier"] } : {}) },
  });
  let publication = "not_requested";
  if (args.output) {
    if (prepared.status !== "ready") publication = "unavailable_not_written";
    else {
      if (resolve(args.output) === resolve(agentDir, "speed-index", SPEED_V2_PROFILE_FILE) &&
          (prepared.profile.devices.length !== 1 || prepared.profile.devices[0] !== "local")) {
        throw new Error("a pooled/exported device profile cannot activate against this machine's local raw logs");
      }
      const written = writeBaselineExclusive(args.output, prepared.profile);
      if (written.ok) publication = "written";
      else {
        let prior;
        try { prior = validateSpeedV2Profile(JSON.parse(readFileSync(args.output, "utf8"))); } catch {}
        if (prior?.hash !== prepared.profile.hash) throw new Error("a different or invalid profile already exists; not overwritten");
        publication = "already_present";
      }
    }
  }
  process.stdout.write(`${JSON.stringify({
    ...prepared, publication,
    input: { rows: input.rows.length, files: input.files, invalidJsonLines: input.invalidJsonLines, duplicateRecords: input.duplicateRecords },
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`Speed profile: ${error.message}`); process.exitCode = 1; }
}
