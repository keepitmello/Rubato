import { replaceOnce } from "./replace-once.mjs";

export function isBootInteractiveModeUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/modes/interactive/interactive-mode.js");
}

const DEFERRED_IMPORTS = [
  ['import { ArminComponent } from "./components/armin.js";\n', "let ArminComponent;\n"],
  ['import { AssistantMessageComponent } from "./components/assistant-message.js";\n', "let AssistantMessageComponent;\n"],
  ['import { BashExecutionComponent } from "./components/bash-execution.js";\n', "let BashExecutionComponent;\n"],
  ['import { BorderedLoader } from "./components/bordered-loader.js";\n', "let BorderedLoader;\n"],
  ['import { BranchSummaryMessageComponent } from "./components/branch-summary-message.js";\n', "let BranchSummaryMessageComponent;\n"],
  ['import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.js";\n', "let CompactionSummaryMessageComponent;\n"],
  ['import { CustomEntryComponent } from "./components/custom-entry.js";\n', "let CustomEntryComponent;\n"],
  ['import { CustomMessageComponent } from "./components/custom-message.js";\n', "let CustomMessageComponent;\n"],
  ['import { DaxnutsComponent } from "./components/daxnuts.js";\n', "let DaxnutsComponent;\n"],
  ['import { EarendilAnnouncementComponent } from "./components/earendil-announcement.js";\n', "let EarendilAnnouncementComponent;\n"],
  ['import { ExtensionEditorComponent } from "./components/extension-editor.js";\n', "let ExtensionEditorComponent;\n"],
  ['import { ExtensionInputComponent } from "./components/extension-input.js";\n', "let ExtensionInputComponent;\n"],
  ['import { ExtensionSelectorComponent } from "./components/extension-selector.js";\n', "let ExtensionSelectorComponent;\n"],
  ['import { FavoriteModelsSelectorComponent } from "./components/favorite-models-selector.js";\n', "let FavoriteModelsSelectorComponent;\n"],
  ['import { LoginDialogComponent } from "./components/login-dialog.js";\n', "let LoginDialogComponent;\n"],
  ['import { createMermaidMarkdownTransformer } from "./components/mermaid.js";\n', "let createMermaidMarkdownTransformer;\n"],
  ['import { ModelSelectorComponent } from "./components/model-selector.js";\n', "let ModelSelectorComponent;\n"],
  [
    'import { formatAuthSelectorProviderType, OAuthSelectorComponent, } from "./components/oauth-selector.js";\n',
    "let formatAuthSelectorProviderType, OAuthSelectorComponent;\n",
  ],
  ['import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.js";\n', "let ScopedModelsSelectorComponent;\n"],
  ['import { SessionSelectorComponent } from "./components/session-selector.js";\n', "let SessionSelectorComponent;\n"],
  ['import { SettingsSelectorComponent } from "./components/settings-selector.js";\n', "let SettingsSelectorComponent;\n"],
  ['import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.js";\n', "let SkillInvocationMessageComponent;\n"],
  ['import { ToolExecutionComponent } from "./components/tool-execution.js";\n', "let ToolExecutionComponent;\n"],
  ['import { TreeSelectorComponent } from "./components/tree-selector.js";\n', "let TreeSelectorComponent;\n"],
  ['import { TrustSelectorComponent } from "./components/trust-selector.js";\n', "let TrustSelectorComponent;\n"],
  ['import { UserMessageComponent } from "./components/user-message.js";\n', "let UserMessageComponent;\n"],
  ['import { UserMessageSelectorComponent } from "./components/user-message-selector.js";\n', "let UserMessageSelectorComponent;\n"],
];

const DEFERRED_ASSIGNMENT = `        ({
            ArminComponent,
            AssistantMessageComponent,
            BashExecutionComponent,
            BorderedLoader,
            BranchSummaryMessageComponent,
            CompactionSummaryMessageComponent,
            CustomEntryComponent,
            CustomMessageComponent,
            DaxnutsComponent,
            EarendilAnnouncementComponent,
            ExtensionEditorComponent,
            ExtensionInputComponent,
            ExtensionSelectorComponent,
            FavoriteModelsSelectorComponent,
            LoginDialogComponent,
            createMermaidMarkdownTransformer,
            ModelSelectorComponent,
            formatAuthSelectorProviderType,
            OAuthSelectorComponent,
            ScopedModelsSelectorComponent,
            SessionSelectorComponent,
            SettingsSelectorComponent,
            SkillInvocationMessageComponent,
            ToolExecutionComponent,
            TreeSelectorComponent,
            TrustSelectorComponent,
            UserMessageComponent,
            UserMessageSelectorComponent,
        } = deferredUi);
        this.mermaidMarkdownTransformer = createMermaidMarkdownTransformer({
            getMode: () => this.settingsManager.getMermaidRenderingMode(),
            theme,
        });
`;

/** 첫 페인트에 안 쓰는 대화상자·mermaid 를 InteractiveMode 정적 그래프에서 뺀다. */
export function injectInteractiveDeferDialogs(source) {
  let next = source;
  for (const [needle, replacement] of DEFERRED_IMPORTS) {
    next = replaceOnce(next, needle, replacement, `interactive defer ${needle.split(" from ")[1]?.trim() ?? needle}`);
  }
  next = replaceOnce(
    next,
    `        this.mermaidMarkdownTransformer = createMermaidMarkdownTransformer({
            getMode: () => this.settingsManager.getMermaidRenderingMode(),
            theme,
        });
`,
    "        this.mermaidMarkdownTransformer = undefined;\n",
    "interactive defer mermaid ctor",
  );
  next = replaceOnce(
    next,
    "        return [this.mermaidMarkdownTransformer, ...this.session.extensionRunner.getMarkdownTransformers()];\n",
    "        return [this.mermaidMarkdownTransformer, ...this.session.extensionRunner.getMarkdownTransformers()].filter(Boolean);\n",
    "interactive defer mermaid transformers",
  );
  next = replaceOnce(
    next,
    "        this.isInitialized = true;\n",
    `        this.isInitialized = true;
        const deferredInteractiveUi = Promise.all([
            import("./components/armin.js"),
            import("./components/assistant-message.js"),
            import("./components/bash-execution.js"),
            import("./components/bordered-loader.js"),
            import("./components/branch-summary-message.js"),
            import("./components/compaction-summary-message.js"),
            import("./components/custom-entry.js"),
            import("./components/custom-message.js"),
            import("./components/daxnuts.js"),
            import("./components/earendil-announcement.js"),
            import("./components/extension-editor.js"),
            import("./components/extension-input.js"),
            import("./components/extension-selector.js"),
            import("./components/favorite-models-selector.js"),
            import("./components/login-dialog.js"),
            import("./components/mermaid.js"),
            import("./components/model-selector.js"),
            import("./components/oauth-selector.js"),
            import("./components/scoped-models-selector.js"),
            import("./components/session-selector.js"),
            import("./components/settings-selector.js"),
            import("./components/skill-invocation-message.js"),
            import("./components/tool-execution.js"),
            import("./components/tree-selector.js"),
            import("./components/trust-selector.js"),
            import("./components/user-message.js"),
            import("./components/user-message-selector.js"),
        ]).then((mods) => Object.assign({}, ...mods));
`,
    "interactive defer start prefetch",
  );
  next = replaceOnce(
    next,
    `        const [fdPath] = await Promise.all([
            ensureTool("fd", (status) => this.showManagedToolStatus(status)),
            ensureTool("rg", (status) => this.showManagedToolStatus(status)),
        ]);
        this.fdPath = fdPath;
`,
    `        const [fdPath, , deferredUi] = await Promise.all([
            ensureTool("fd", (status) => this.showManagedToolStatus(status)),
            ensureTool("rg", (status) => this.showManagedToolStatus(status)),
            deferredInteractiveUi,
        ]);
        this.fdPath = fdPath;
${DEFERRED_ASSIGNMENT}`,
    "interactive defer await prefetch",
  );
  return next;
}
