import { replaceOnce } from "./replace-once.mjs";

export function isAssistantMessageUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/modes/interactive/components/assistant-message.js");
}

export function assistantInternalActionsHref() {
  return new URL("./internal-actions.mjs", import.meta.url).href;
}

/**
 * Baseline thinking click-to-expand + #17 lifecycle + #18/#19/#20/#24 turn-work.
 * Import of registerInternalAction is rewritten to the in-repo href (new vendor file).
 */
export function injectAssistantMessage(source, href = assistantInternalActionsHref()) {
  let next = replaceOnce(
    source,
    'import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";',
    'import { Container, hyperlink, Markdown, Spacer, Text } from "@earendil-works/pi-tui";',
    "assistant hyperlink import",
  );
  next = replaceOnce(
    next,
    'import { getMarkdownTheme, theme } from "../theme/theme.js";\n',
    `import { getMarkdownTheme, theme } from "../theme/theme.js";\nimport { registerInternalAction } from ${JSON.stringify(href)};\n`,
    "assistant internal-actions import",
  );
  next = replaceOnce(
    next,
    "        this.expanded = false;\n        this.isStreaming = false;\n        this.hideThinkingBlock = hideThinkingBlock;",
    `        this.expanded = false;
        this.isStreaming = false;
        this.turnWorkCollapsed = false;
        this.hideProgress = false;
        this.thinkingExpanded = false;
        // 런별 수동 선택. 키는 그 런의 startedAt — 메시지 단위로 두면 앞 런에서
        // 누른 것이 뒤 런까지 짓눌러 새 사고가 통째로 안 보인다.
        this.thinkingOverrides = new Map();
        this.hideThinkingBlock = hideThinkingBlock;
        this.thinkingAction = registerInternalAction(() => {
            // 라벨을 누를 때 보이는 것은 마지막 런이다. 그 런에만 선택을 남긴다.
            const key = this.lastThinkingRunKey;
            if (key === undefined)
                return;
            this.thinkingOverrides.set(key, !this.isThinkingRunExpanded(key, this.lastThinkingRunActive));
            this.refreshContent();
        });`,
    "assistant constructor thinking state",
  );
  next = replaceOnce(
    next,
    `    setHideThinkingBlock(hide) {
        if (this.hideThinkingBlock === hide)
            return;
        this.hideThinkingBlock = hide;
        this.refreshContent();
    }
    setHiddenThinkingLabel(label) {`,
    `    setHideThinkingBlock(hide) {
        if (this.hideThinkingBlock === hide)
            return;
        this.hideThinkingBlock = hide;
        this.refreshContent();
    }
    dispose() {
        this.thinkingAction.dispose();
        super.dispose();
    }
    setHiddenThinkingLabel(label) {`,
    "assistant dispose",
  );
  next = replaceOnce(
    next,
    `    setExpanded(expanded) {
        if (this.expanded === expanded)
            return;
        this.expanded = expanded;
        this.refreshContent();
    }
    setOutputPad(padding) {`,
    `    setExpanded(expanded) {
        if (this.expanded === expanded)
            return;
        this.expanded = expanded;
        this.refreshContent();
    }
    setTurnWorkCollapsed(collapsed) {
        if (this.turnWorkCollapsed === collapsed)
            return;
        this.turnWorkCollapsed = collapsed;
        this.refreshContent();
    }
    setHideProgress(hide) {
        if (this.hideProgress === hide)
            return;
        this.hideProgress = hide;
        this.refreshContent();
    }
    setOutputPad(padding) {`,
    "assistant setTurnWorkCollapsed",
  );
  next = replaceOnce(
    next,
    "        this.lastMessage = message;\n        const messageSignature = this.createMessageSignature(message);",
    `        this.lastMessage = message;
        // 사고의 열림/닫힘을 먼저 정하고 그 결과로 서명을 만든다. 순서가 반대면
        // "마지막 델타 없이 endedAt 만 찍힌다" 는 접힘 순간이 서명 동일로 걸려 생략된다.
        this.syncThinkingExpansion(message);
        const messageSignature = this.createMessageSignature(message);`,
    "assistant sync thinking before signature",
  );
  next = replaceOnce(
    next,
    `        const descriptors = createAssistantRenderDescriptors(message, {
            expanded: this.expanded,
            hiddenThinkingLabel: this.hiddenThinkingLabel,
            hideThinkingBlock: this.hideThinkingBlock,
            hasToolCalls: this.hasToolCalls,
        });`,
    `        const descriptors = createAssistantRenderDescriptors(message, {
            expanded: this.expanded,
            hiddenThinkingLabel: this.hiddenThinkingLabel,
            // 런마다 따로 묻는다: 끝난 런은 접히고 흐르는 런은 펼쳐진다.
            hideThinkingBlock: this.hideThinkingBlock
                ? (run) => !this.isThinkingRunExpanded(run.startedAt, !run.isDone)
                : false,
            hasToolCalls: this.hasToolCalls,
            hideTurnWork: this.turnWorkCollapsed,
            hideProgress: this.hideProgress,
        });`,
    "assistant descriptor options",
  );
  next = replaceOnce(
    next,
    `            case "thinking-label":
            case "error-text":
                return new Text(descriptor.text, this.outputPad, 0);`,
    `            case "thinking-label":
                return new Text(hyperlink(descriptor.text, this.thinkingAction.url), this.outputPad, 0);
            case "error-text":
                return new Text(descriptor.text, this.outputPad, 0);`,
    "assistant thinking-label hyperlink",
  );
  next = replaceOnce(
    next,
    "                return assertNever(descriptor.kind);\n        }\n    }\n    createMessageSignature(message) {",
    `                return assertNever(descriptor.kind);
        }
    }
    /**
     * 사고 블록은 자기 수명을 따라 열리고 닫힌다 — 델타가 흐르는 동안은 펼쳐서
     * 그대로 보여주고, 마지막 조각에 endedAt 이 찍히면 접어서 라벨만 남긴다.
     *
     * 판정에 isStreaming 을 쓰지 않는 이유: 그것은 턴 전체가 흐르는지를 말하므로
     * 사고가 끝나고 본문이 나오는 동안에도 참이다. 사고 파트 자신의 endedAt 이
     * 우리가 접어야 하는 순간을 정확히 짚는다.
     */
    syncThinkingExpansion(message) {
        // 마지막 사고 런을 찾는다 — 라벨 토글이 가리키는 대상이다.
        let key;
        let active = false;
        let runStart;
        let runActive = false;
        let inRun = false;
        for (const content of message.content) {
            if (content.type === "thinking") {
                if (!inRun) {
                    inRun = true;
                    runStart = content.startedAt ?? Number.POSITIVE_INFINITY;
                    runActive = false;
                }
                if (content.startedAt !== undefined && content.endedAt === undefined)
                    runActive = true;
                continue;
            }
            if (inRun) {
                key = runStart;
                active = runActive;
                inRun = false;
            }
        }
        if (inRun) {
            key = runStart;
            active = runActive;
        }
        this.lastThinkingRunKey = key;
        this.lastThinkingRunActive = active;
        this.thinkingExpanded = key === undefined ? false : this.isThinkingRunExpanded(key, active);
    }
    /**
     * 이 런을 펼 것인가. 사용자가 이 런을 직접 눌렀으면 그 선택이 이기고,
     * 아니면 수명을 따른다 — 흐르는 동안 펼쳐지고 끝나면 접힌다.
     */
    isThinkingRunExpanded(key, active) {
        const override = key === undefined ? undefined : this.thinkingOverrides.get(key);
        return override ?? active;
    }
    createMessageSignature(message) {`,
    "assistant thinking helpers",
  );
  next = replaceOnce(
    next,
    `        return createBoundedRenderSignature({
            content: message.content,
            hiddenThinkingLabel: this.hiddenThinkingLabel,
            hideThinkingBlock: this.hideThinkingBlock,
            errorState: [message.diagnostics, message.errorMessage],
            stopReason: message.stopReason,
        });`,
    `        return createBoundedRenderSignature({
            content: message.content,
            hiddenThinkingLabel: this.hiddenThinkingLabel,
            hideThinkingBlock: this.hideThinkingBlock,
            thinkingExpanded: this.thinkingExpanded,
            thinkingOverrides: [...this.thinkingOverrides].flat(),
            errorState: [message.diagnostics, message.errorMessage],
            stopReason: message.stopReason,
            turnWorkCollapsed: this.turnWorkCollapsed,
            hideProgress: this.hideProgress,
        });`,
    "assistant signature fields",
  );
  next = replaceOnce(
    next,
    "//# sourceMappingURL=assistant-message.js.map",
    "//# sourceMappingURL=assistant-message.js.map\n",
    "assistant sourcemap newline",
  );
  return next;
}
