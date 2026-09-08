import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRubatoComponents } from "./build-rubato.mjs";
import { loadPiFeatures } from "./feature-catalog.mjs";
import { stagePiRuntime } from "./stage-runtime.mjs";
import { CANDIDATE_FEATURE_NAMES } from "./features/rubato-components/candidate-main.mjs";
import { validateCandidateStage } from "./features/rubato-components/validate-stage.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** One explicit build command for the incomplete candidate. It neither installs
 * dependencies nor switches the normal launcher/profile. Existing output fails.
 */
export async function buildRubatoCandidate({ outputRoot, sourceRoot = here, repoRoot, bunExecutable } = {}) {
  if (typeof outputRoot !== "string" || !isAbsolute(outputRoot)) throw new Error("Candidate build requires a new absolute outputRoot");
  const exists = await lstat(outputRoot).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
  if (exists) throw new Error("Candidate output already exists; choose a new directory");
  const scratch = await mkdtemp(join(tmpdir(), "rubato-candidate-build-"));
  try {
    const build = await buildRubatoComponents({ outputRoot: join(scratch, "components"), sourceRoot, repoRoot, bunExecutable });
    const features = await loadPiFeatures(CANDIDATE_FEATURE_NAMES);
    const staged = await stagePiRuntime({ sourceRoot, outputRoot, features: [...features, build.feature] });
    await validateCandidateStage(staged.root, staged.receipt);
    await rm(scratch, { recursive: true, force: true });
    return { ...staged, candidateEntry: join(staged.root, "rubato-features/rubato-components/candidate-main.mjs") };
  } catch (cause) {
    // Preserve the exact task-owned failed build and stage receipt for diagnosis.
    throw new Error(`Candidate build failed; diagnostic build retained at ${scratch}`, { cause });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output") {
    console.error("Usage: node build-candidate.mjs --output /absolute/new-candidate-directory");
    process.exitCode = 1;
  } else {
    buildRubatoCandidate({ outputRoot: args[1] }).then(({ root, receipt, candidateEntry }) => {
      console.log(JSON.stringify({ root, candidateEntry, stockVersion: receipt.stockVersion,
        fullRubatoParity: receipt.fullRubatoParity, features: receipt.features, profileEnv: "RUBATO_CANDIDATE_AGENT_DIR" }, null, 2));
    }).catch((error) => { console.error(error); process.exitCode = 1; });
  }
}
