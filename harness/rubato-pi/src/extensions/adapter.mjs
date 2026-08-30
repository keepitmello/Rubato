import { join } from "node:path";
import { rubatoExtension } from "../engine-paths.mjs";
import { resolveRole } from "../role-contract.mjs";
import { promptForAgentStart } from "../system-prompt.mjs";
import { isTeamMemberProcess, parseMemberIdentity } from "../member-identity.mjs";
import { registerMemberBoardTools, restoreMemberTaskEngine } from "../member-tools.mjs";
import { rubatoPiMemoryComponent, rubatoPiTaskComponent } from "../rubato-runtime.mjs";
import { DAG_RUBATO_OWNED_COMPONENTS } from "../policy.mjs";
import { provisionSpecWorktrees } from "../team-worktrees.mjs";
import { contractSkillsMessage, shouldInjectContractSkills } from "../contract-skills.mjs";
import { installStatusline } from "./statusline.mjs";
import { installSessionTitle } from "./session-title.mjs";
import { installEvalSearchGuard } from "../eval-search-guard.mjs";
import { installMeasurementHooks } from "../measurement-recorder.mjs";

const { composeRubatoExtension, rubatoComponents } = await import(rubatoExtension);

const DAG_RUBATO_OWNED = new Set(DAG_RUBATO_OWNED_COMPONENTS);

function leadOverlayLoaded(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if ((argv[i] === "-e" || argv[i] === "--extension") && argv[i + 1]?.endsWith("lead-overlay.mjs")) {
      return true;
    }
  }
  return false;
}

const replaceMemory = rubatoPiMemoryComponent !== undefined;
const dagOverlay = composeRubatoExtension([
  ...rubatoComponents.filter((component) => DAG_RUBATO_OWNED.has(component.name) && (!replaceMemory || component.name !== "memory")),
  ...(replaceMemory ? [rubatoPiMemoryComponent] : []),
]);
const taskComponent = rubatoPiTaskComponent;

export default async function rubatoPiAdapter(pi) {
  installStatusline(pi);
  installEvalSearchGuard(pi);
  installMeasurementHooks(pi);
  const member = isTeamMemberProcess();
  const role = resolveRole();
  if (!member) installSessionTitle(pi);
  if (!leadOverlayLoaded(process.argv) && !member) {
    await dagOverlay(pi);
  }
  if (member && taskComponent) {
    await restoreMemberTaskEngine(composeRubatoExtension, taskComponent, pi);
    registerMemberBoardTools(pi, parseMemberIdentity() ?? {});
  }

  pi.on("session_start", (event, ctx) => {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    if (!shouldInjectContractSkills(event.reason, entries)) return;
    pi.sendMessage(contractSkillsMessage(role), { triggerTurn: false, deliverAs: "nextTurn" });
  });

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
