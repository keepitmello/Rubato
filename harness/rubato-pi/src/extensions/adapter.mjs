import { join } from "node:path";
import { assertEngineBuilt, rubatoExtension } from "../engine-paths.mjs";
import { resolveRole } from "../role-contract.mjs";
import { promptForAgentStart } from "../system-prompt.mjs";
import { isTeamMemberProcess, parseMemberIdentity } from "../member-identity.mjs";
import { registerMemberBoardTools, restoreMemberTaskEngine } from "../member-tools.mjs";
import { rubatoPiMemoryComponent, rubatoPiTaskComponent } from "../rubato-runtime.mjs";
import { DAG_RUBATO_OWNED_COMPONENTS } from "../policy.mjs";
import { provisionSpecWorktrees } from "../team-worktrees.mjs";
import { installStatusline } from "./statusline.mjs";
import { installSessionTitle } from "./session-title.mjs";
import { installEvalSearchGuard } from "../eval-search-guard.mjs";
import { installMeasurementHooks } from "../measurement-recorder.mjs";
import { installRemoteSurface } from "./remote-surface.mjs";

assertEngineBuilt();
const { composeRubatoExtension, rubatoComponents } = await import(rubatoExtension);

const DAG_RUBATO_OWNED = new Set(DAG_RUBATO_OWNED_COMPONENTS);

function cliExtensionLoaded(argv, suffix) {
  for (let i = 0; i < argv.length; i += 1) {
    if ((argv[i] === "-e" || argv[i] === "--extension") && argv[i + 1]?.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

function leadOverlayLoaded(argv) {
  return cliExtensionLoaded(argv, "lead-overlay.mjs");
}

function statuslineExtensionLoaded(argv = process.argv) {
  return cliExtensionLoaded(argv, "statusline.mjs");
}

const replaceMemory = rubatoPiMemoryComponent !== undefined;
const dagOverlay = composeRubatoExtension([
  ...rubatoComponents.filter((component) => DAG_RUBATO_OWNED.has(component.name) && (!replaceMemory || component.name !== "memory")),
  ...(replaceMemory ? [rubatoPiMemoryComponent] : []),
]);
const taskComponent = rubatoPiTaskComponent;

export default async function rubatoPiAdapter(pi) {
  // launch 가 `-e statusline.mjs` 를 adapter 보다 먼저 붙인다. 그 경로가
  // 이미 깔렸으면 여기서 다시 install 하면 probe/handler 가 두 벌이 된다.
  if (!statuslineExtensionLoaded()) {
    const statusline = installStatusline(pi);
    await statusline.attachHost?.();
  }
  installEvalSearchGuard(pi);
  installMeasurementHooks(pi);
  const member = isTeamMemberProcess();
  const role = resolveRole();
  if (!member) installSessionTitle(pi);
  if (!member && process.env.RUBATO_LIVE_SESSION_ID) {
    await installRemoteSurface(pi);
  }
  if (!leadOverlayLoaded(process.argv) && !member) {
    await dagOverlay(pi);
  }
  if (member && taskComponent) {
    await restoreMemberTaskEngine(composeRubatoExtension, taskComponent, pi);
    registerMemberBoardTools(pi, parseMemberIdentity() ?? {});
  }

  pi.on("before_agent_start", async (event, ctx) => ({
    systemPrompt: promptForAgentStart(event, ctx, role),
  }));

  pi.on("tool_call", async (event) => {
    if (event.toolName === "team_create") {
      const spec = event.input?.inline_spec ?? event.input?.inlineSpec;
      const repo = process.cwd();
      const destRoot = join(process.env.SENPI_CODING_AGENT_DIR ?? repo, "worktrees");
      const next = await provisionSpecWorktrees(spec, { repo, destRoot });
      if (event.input && next) {
        if (event.input.inline_spec) event.input.inline_spec = next;
        if (event.input.inlineSpec) event.input.inlineSpec = next;
      }
    }
  });
}
