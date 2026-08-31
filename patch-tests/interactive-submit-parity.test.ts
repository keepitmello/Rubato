import { expect, test } from "bun:test";
import { VENDOR_PATCHES } from "../postinstall.mjs";

const root = VENDOR_PATCHES[0].resolveRoot();
const { InteractiveMode } = await import(`${root}/dist/modes/interactive/interactive-mode.js`);

function host(streaming = false) {
  const prompts: any[] = [];
  const submissions: any[] = [];
  const value: any = {
    preResolvedSubmissionImages: undefined,
    hideShortcutOverlay() {},
    lastEditorText: "",
    isExtensionCommand: () => false,
    takeSubmissionImages: () => [],
    flushPendingBashComponents() {},
    onInputCallback: (submission: unknown) => submissions.push(submission),
    pendingUserInputs: [],
    optimisticUserEchoes: {
      begin: () => "echo",
      promptOptions: () => ({ source: "interactive" }),
      reject() {},
    },
    editor: { addToHistory() {}, setText() {} },
    defaultEditor: { addToHistory() {}, setText() {} },
    session: {
      isStreaming: streaming,
      isCompacting: false,
      isBashRunning: false,
      prompt: async (text: string, options: unknown) => prompts.push({ text, options }),
    },
    updatePendingMessagesDisplay() {},
    ui: { requestRender() {} },
  };
  value.editor = value.defaultEditor;
  InteractiveMode.prototype.setupEditorSubmitHandler.call(value);
  return { value, prompts, submissions };
}

test("editor and external ordinary input converge on AgentSession.prompt", async () => {
  const editor = host();
  await editor.value.dispatchInteractiveInput("/skill:review carefully", [], "editor", "auto");
  const submission = editor.submissions[0];
  await editor.value.session.prompt(submission.text, { images: submission.images });

  const remote = host();
  await remote.value.dispatchInteractiveInput("/skill:review carefully", [], "external", "auto");
  expect(remote.prompts[0].text).toBe(editor.prompts[0].text);
});

test("streaming external steer and follow-up use the same prompt dispatcher", async () => {
  const remote = host(true);
  await remote.value.dispatchInteractiveInput("steer", [], "external", "steer");
  await remote.value.dispatchInteractiveInput("later", [], "external", "followUp");
  expect(remote.prompts.map((call) => call.options.streamingBehavior)).toEqual(["steer", "followUp"]);
});

test("editor /compact and native facade compact call the same handler", async () => {
  const calls: unknown[] = [];
  const editor = host();
  editor.value.handleCompactCommand = async (instructions: unknown) => calls.push(instructions);
  await editor.value.dispatchInteractiveInput("/compact preserve facts", [], "editor", "auto");

  const facadeHost: any = {
    ...editor.value,
    listInteractiveCommands: () => [],
    handleCompactCommand: async (instructions: unknown) => calls.push(instructions),
  };
  const facade = InteractiveMode.prototype.createInteractiveControlSurface.call(facadeHost);
  await facade.compact("preserve facts");
  expect(calls).toEqual(["preserve facts", "preserve facts"]);
});
