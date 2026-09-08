// Senpi-origin apply_patch behavior adapted to stock Pi's public constrainedSampling API.
// MIT attribution and license: ./THIRD_PARTY_NOTICES.md

import { Type } from "typebox";

import { applyPatchDetailed, buildPartialFailureText } from "./patch-engine.mjs";
import { parsePatch } from "./patch-format.mjs";

export const APPLY_PATCH_NAME = "apply_patch";
const EDIT_TOOL_NAMES = new Set(["edit", "write"]);
const FREEFORM_APIS = new Set([
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);

export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

const DESCRIPTION_BODY = `Use the \`apply_patch\` tool to edit files.
Your patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high-level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

May be immediately followed by *** Move to: <new path> if you want to rename the file.
Then one or more hunks, each introduced by @@ (optionally followed by a hunk header).
Within a hunk each line starts with:

For instructions on [context_before] and [context_after]:
- By default, show 3 lines of code immediately above and 3 lines immediately below each change. If a change is within 3 lines of a previous change, do NOT duplicate the first change's [context_after] lines in the second change's [context_before] lines.
- If 3 lines of context is insufficient to uniquely identify the snippet of code within the file, use the @@ operator to indicate the class or function to which the snippet belongs.
- If a code block is repeated so many times that a single @@ statement is insufficient, use multiple @@ statements to jump to the right context.

The grammar is:
Patch := Begin { FileOp } End
Begin := "*** Begin Patch" NEWLINE
End := "*** End Patch" NEWLINE
FileOp := AddFile | DeleteFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile := "*** Delete File: " path NEWLINE
UpdateFile := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }
MoveTo := "*** Move to: " newPath NEWLINE
Hunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine := (" " | "-" | "+") text NEWLINE

It is important to remember:
- You must include a header with your intended action (Add/Delete/Update).
- You must prefix new lines with + even when creating a new file.
- File references can only be relative, NEVER ABSOLUTE.`;
export const APPLY_PATCH_JSON_DESCRIPTION = `Pass the entire patch as the \`input\` string argument.\n${DESCRIPTION_BODY}`;
export const APPLY_PATCH_FREEFORM_DESCRIPTION = "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.";

const APPLY_PATCH_PARAMETERS = Type.Object({
  input: Type.String({ description: "The entire contents of the apply_patch command" }),
});

export function normalizeApplyPatchArguments(args) {
  if (typeof args === "string") return { input: args };
  return args && typeof args === "object" && typeof args.input === "string"
    ? { input: args.input }
    : { input: "" };
}

/** Current Rubato policy: only supported GPT Responses routes use custom/freeform; all other routes use JSON. */
export function getApplyPatchWireMode(model) {
  const isGpt = typeof model?.id === "string" && model.id.startsWith("gpt-");
  return isGpt && FREEFORM_APIS.has(model?.api) ? "freeform" : "json";
}

export function createApplyPatchTool(variant = "json") {
  return {
    name: APPLY_PATCH_NAME,
    label: "ApplyPatch",
    description: variant === "freeform" ? APPLY_PATCH_FREEFORM_DESCRIPTION : APPLY_PATCH_JSON_DESCRIPTION,
    promptSnippet: "Apply Codex-format file patches with apply_patch",
    promptGuidelines: [
      "Use apply_patch for file edits instead of mutating files through bash, Python scripts, heredocs, or shell redirection.",
      "After apply_patch succeeds, do not re-read the edited files just to confirm the patch applied.",
    ],
    parameters: APPLY_PATCH_PARAMETERS,
    ...(variant === "freeform" ? {
      constrainedSampling: { type: "grammar", variants: { openai_lark: APPLY_PATCH_LARK_GRAMMAR } },
    } : {}),
    executionMode: "sequential",
    prepareArguments: normalizeApplyPatchArguments,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { input } = normalizeApplyPatchArguments(params);
      if (!input) throw new Error("input is required");
      // Parse before the first update so invalid input cannot look like accepted work.
      const total = parsePatch(input).length;
      onUpdate?.({
        content: [{ type: "text", text: total > 0 ? `Applying patch (0/${total})` : "Applying patch" }],
        details: { progress: total > 0 ? { applied: 0, failed: 0, total } : undefined },
      });
      const result = await applyPatchDetailed(ctx.cwd, input, {
        signal,
        onProgress(progress) {
          onUpdate?.({
            content: [{ type: "text", text: `Applying patch (${progress.applied + progress.failed}/${progress.total})` }],
            details: { progress },
          });
        },
      });
      if (result.failures.length > 0) {
        return { content: [{ type: "text", text: buildPartialFailureText(result) }], details: { result } };
      }
      return { content: [{ type: "text", text: result.summaries.join("\n") }], details: { result } };
    },
  };
}

function replaceEditors(toolNames) {
  const hadApplyPatch = toolNames.includes(APPLY_PATCH_NAME);
  const insertAt = toolNames.findIndex((name) => EDIT_TOOL_NAMES.has(name) || name === APPLY_PATCH_NAME);
  const filtered = toolNames.filter((name) => name !== APPLY_PATCH_NAME && !EDIT_TOOL_NAMES.has(name));
  if (!hadApplyPatch && !toolNames.some((name) => EDIT_TOOL_NAMES.has(name))) return filtered;
  const index = insertAt < 0 ? filtered.length : Math.min(insertAt, filtered.length);
  return [...filtered.slice(0, index), APPLY_PATCH_NAME, ...filtered.slice(index)];
}

function hasFailures(details) {
  return Array.isArray(details?.result?.failures) && details.result.failures.length > 0;
}

export function registerApplyPatchExtension(pi) {
  const state = { wireMode: "json", activeVariant: "json" };
  const variants = {
    json: createApplyPatchTool("json"),
    freeform: createApplyPatchTool("freeform"),
  };
  pi.registerTool(variants.json);

  const sync = (model) => {
    const mode = getApplyPatchWireMode(model);
    state.wireMode = mode;
    if (state.activeVariant !== mode) {
      pi.registerTool(variants[mode]);
      state.activeVariant = mode;
    }
    pi.setActiveTools(replaceEditors(pi.getActiveTools()));
  };

  pi.registerLazyToolActivator?.((name) => {
    if (name !== APPLY_PATCH_NAME || pi.getActiveTools().includes(name)) return false;
    pi.setActiveTools([...pi.getActiveTools(), name]);
    return true;
  });
  pi.on("session_start", (_event, ctx) => sync(ctx.model));
  pi.on("model_select", (event) => sync(event.model));
  pi.on("tool_result", (event) => {
    if (event.toolName !== APPLY_PATCH_NAME || event.isError || !hasFailures(event.details)) return undefined;
    return { isError: true };
  });
}

export default registerApplyPatchExtension;
