import { replaceOnce } from "./replace-once.mjs";

export function isInteractiveModeUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/modes/interactive/interactive-mode.js");
}

export function interactiveChromeHrefs() {
  return {
    internalActions: new URL("./internal-actions.mjs", import.meta.url).href,
    toolGroup: new URL("./tool-group-component.mjs", import.meta.url).href,
    turnWork: new URL("./turn-work-summary.mjs", import.meta.url).href,
    requestRun: new URL("./request-run-tracker.mjs", import.meta.url).href,
    assistantPhase: new URL("./assistant-phase.mjs", import.meta.url).href,
  };
}

/**
 * InteractiveMode grouping / turn-work / abort-once / slash hide.
 * New vendor modules are imported via in-repo hrefs (footer pattern).
 */
export function injectInteractiveModeChrome(source, hrefs = interactiveChromeHrefs()) {
  const {
    internalActions = interactiveChromeHrefs().internalActions,
    toolGroup = interactiveChromeHrefs().toolGroup,
    turnWork = interactiveChromeHrefs().turnWork,
    requestRun = interactiveChromeHrefs().requestRun,
    assistantPhase = interactiveChromeHrefs().assistantPhase,
  } = hrefs;
  let next = source;
  next = replaceOnce(
    next,
    "import { GrokChrome } from \"./grok/chrome.js\";\nimport { restoreInteractiveStderr, takeOverInteractiveStderr } from \"./interactive-stderr-guard.js\";",
    `import { GrokChrome } from "./grok/chrome.js";
import { dispatchInternalAction } from ${JSON.stringify(internalActions)};
import { ToolGroupComponent } from ${JSON.stringify(toolGroup)};
import { TurnWorkSummaryComponent } from ${JSON.stringify(turnWork)};
import { restoreInteractiveStderr, takeOverInteractiveStderr } from "./interactive-stderr-guard.js";`,
    "interactive imports",
  );
  next = replaceOnce(
    next,
    "    return provider.name === provider.id ? authTypes : `${provider.name} · ${authTypes}`;\n}\n/**\n * Content the streaming component owns: everything through the FIRST toolCall.",
    "    return provider.name === provider.id ? authTypes : `${provider.name} · ${authTypes}`;\n}\nfunction lastAssistantTextRunStart(content) {\n    if (content.length === 0 || content[content.length - 1]?.type === \"toolCall\")\n        return -1;\n    let start = content.length - 1;\n    while (start > 0 && content[start - 1]?.type !== \"toolCall\")\n        start -= 1;\n    return start;\n}\n/**\n * Abort/error/length belong on the last assistant fragment of the turn.\n * Copying them onto every text run reprints the same red line after each\n * tool group. pending/toolUse stay intact so streaming ellipsis hiding still\n * sees those reasons on the head.\n */\nfunction turnTailStopReason(stopReason, isFinalRun) {\n    if (isFinalRun)\n        return stopReason;\n    if (stopReason === \"aborted\" || stopReason === \"error\" || stopReason === \"length\")\n        return \"stop\";\n    return stopReason;\n}\n/**\n * Content the streaming component owns: everything through the FIRST toolCall.",
    "abort helpers",
  );
  next = replaceOnce(
    next,
    "    if (firstToolIndex === -1)\n        return message;\n    return { ...message, content: message.content.slice(0, firstToolIndex + 1) };\n}",
    "    if (firstToolIndex === -1)\n        return message;\n    const lastRunStart = lastAssistantTextRunStart(message.content);\n    return {\n        ...message,\n        content: message.content.slice(0, firstToolIndex + 1),\n        stopReason: turnTailStopReason(message.stopReason, lastRunStart === -1),\n    };\n}",
    "streaming head stopReason",
  );
  next = replaceOnce(
    next,
    "            openUrl: openBrowser,",
    "            openUrl: (url) => {\n                if (!dispatchInternalAction(url))\n                    openBrowser(url);\n            },",
    "openUrl dispatch",
  );
  next = replaceOnce(
    next,
    "        const builtinCommandNames = new Set(slashCommands.map((c) => c.name));\n        const extensionCommands = this.session.extensionRunner\n            .getRegisteredCommands()\n            .filter((cmd) => !builtinCommandNames.has(cmd.name))\n            .map((cmd) => ({",
    "        const builtinCommandNames = new Set(slashCommands.map((c) => c.name));\n        const hiddenFromMenu = process.env.RUBATO_SHOW_ALL_COMMANDS === \"1\"\n            ? new Set()\n            : new Set([\"dag\", \"doctor\", \"dream\", \"facts\", \"init\", \"memfs\", \"memory\",\n                \"memory-repository\", \"palace\", \"people\", \"recompile\", \"reflect\",\n                \"remember\", \"sleeptime\", \"task-kill\", \"tasks\"]);\n        const hiddenRubatoCommands = new Set([\n            \"dag\", \"doctor\", \"dream\", \"facts\", \"init\", \"memfs\", \"memory\", \"memory-repository\",\n            \"palace\", \"people\", \"recompile\", \"reflect\", \"remember\", \"sleeptime\", \"task-kill\", \"tasks\",\n        ]);\n        const extensionCommands = this.session.extensionRunner\n            .getRegisteredCommands()\n            .filter((cmd) => !builtinCommandNames.has(cmd.name))\n            .filter((cmd) => !hiddenFromMenu.has(cmd.name))\n            .filter((cmd) => process.env.RUBATO_SHOW_ALL_COMMANDS === \"1\" || !hiddenRubatoCommands.has(cmd.invocationName))\n            .map((cmd) => ({",
    "hidden slash commands",
  );
  next = replaceOnce(
    next,
    "                this.turnWorkingTip.resetForNewTurn();\n                if (this.settingsManager.getShowTerminalProgress()) {",
    "                this.turnWorkingTip.resetForNewTurn();\n                // 직전 턴 요약은 트리에 남기고 포인터만 끊는다. 재사용하면\n                // 다음 턴 도구가 앞 턴 불릿에 섞인다.\n                this.turnWorkSummary = undefined;\n                this.startTurnWorkSummary();\n                if (this.settingsManager.getShowTerminalProgress()) {",
    "agent_start turn work",
  );
  next = replaceOnce(
    next,
    "                else if (event.message.role === \"assistant\") {\n                    this.streamingComponent = new AssistantMessageComponent(undefined, this.hideThinkingBlock, this.getMarkdownThemeWithSettings(), this.hiddenThinkingLabel, this.outputPad, this.getMarkdownTransformers());\n                    this.streamingComponent.setExpanded(this.toolOutputExpanded);\n                    this.streamingMessage = event.message;\n                    this.chatContainer.addChild(this.streamingComponent);\n                    this.streamingReveal.begin(this.streamingComponent, assistantStreamingHeadMessage(this.streamingMessage));",
    "                else if (event.message.role === \"assistant\") {\n                    this.startTurnWorkSummary();\n                    this.streamingComponent = new AssistantMessageComponent(undefined, this.hideThinkingBlock, this.getMarkdownThemeWithSettings(), this.hiddenThinkingLabel, this.outputPad, this.getMarkdownTransformers());\n                    this.streamingComponent.setExpanded(this.toolOutputExpanded);\n                    this.streamingMessage = event.message;\n                    this.chatContainer.addChild(this.streamingComponent);\n                    this.turnWorkSummary?.trackAssistant(this.streamingComponent, assistantStreamingHeadMessage(event.message));\n                    this.streamingReveal.begin(this.streamingComponent, assistantStreamingHeadMessage(this.streamingMessage));",
    "message_start track assistant",
  );
  next = replaceOnce(
    next,
    "            case \"message_update\":\n                if (this.streamingComponent && event.message.role === \"assistant\") {\n                    this.streamingMessage = event.message;\n                    this.streamingReveal.setTarget(assistantStreamingHeadMessage(event.message));\n                    for (const content of this.streamingMessage.content) {\n                        if (content.type === \"toolCall\") {\n                            let component = this.pendingTools.get(content.id);\n                            if (!component) {\n                                component = this.createToolExecutionComponent(content.name, content.id, content.arguments);\n                                component.setExpanded(this.toolOutputExpanded);\n                                this.chatContainer.addChild(component);\n                                this.pendingTools.set(content.id, component);",
    "            case \"message_update\":\n                if (this.streamingComponent && event.message.role === \"assistant\") {\n                    this.streamingMessage = event.message;\n                    this.turnWorkSummary?.trackAssistant(this.streamingComponent, assistantStreamingHeadMessage(event.message));\n                    this.streamingReveal.setTarget(assistantStreamingHeadMessage(event.message));\n                    for (const [contentIndex, content] of this.streamingMessage.content.entries()) {\n                        if (content.type === \"toolCall\") {\n                            let component = this.pendingTools.get(content.id);\n                            if (!component) {\n                                // 한 번의 업데이트가 \"새 말 + 그 뒤 도구\" 를 한꺼번에 실어 오면,\n                                // 도구가 먼저 달리는 말을 몰라 앞 뭉침에 붙는다. 말은 그 뒤에\n                                // 동기화되므로 그때 닫아봐야 이미 늦다. 내 앞에 말이 있으면\n                                // 붙기 전에 내가 직접 끊는다 — 순서는 본문이 정하지\n                                // 도착 시각이 정하는 게 아니다.\n                                if (this.streamingMessage.content[contentIndex - 1]?.type !== \"toolCall\" && contentIndex > 0)\n                                    this.closeToolGroup();\n                                component = this.createToolExecutionComponent(content.name, content.id, content.arguments);\n                                component.setExpanded(this.toolOutputExpanded);\n                                this.attachToolComponent(content.name, component);\n                                this.pendingTools.set(content.id, component);",
    "message_update interleave",
  );
  next = replaceOnce(
    next,
    "                    if (this.streamingMessage.stopReason === \"aborted\" || this.streamingMessage.stopReason === \"error\") {",
    "                    if (this.streamingMessage.stopReason === \"aborted\") {\n                        // Cancel is a turn-level event. Stamping every pending tool\n                        // reprints \"Operation aborted\" once per call.\n                        this.clearPendingTools();\n                    }\n                    else if (this.streamingMessage.stopReason === \"error\") {",
    "abort once streaming",
  );
  next = replaceOnce(
    next,
    "                    component = this.createToolExecutionComponent(event.toolName, event.toolCallId, event.args);\n                    component.setExpanded(this.toolOutputExpanded);\n                    this.chatContainer.addChild(component);\n                    this.pendingTools.set(event.toolCallId, component);",
    "                    component = this.createToolExecutionComponent(event.toolName, event.toolCallId, event.args);\n                    component.setExpanded(this.toolOutputExpanded);\n                    this.attachToolComponent(event.toolName, component);\n                    this.pendingTools.set(event.toolCallId, component);",
    "attach tool_execution start",
  );
  next = replaceOnce(
    next,
    "                    component = this.createToolExecutionComponent(event.toolName, event.toolCallId, {});\n                    component.setExpanded(this.toolOutputExpanded);\n                    this.chatContainer.addChild(component);\n                    this.pendingTools.set(event.toolCallId, component);\n                }\n                this.toolResultReveal.finish(event.toolCallId);\n                component.updateResult({ ...event.result, isError: event.isError });\n                this.pendingTools.delete(event.toolCallId);",
    "                    component = this.createToolExecutionComponent(event.toolName, event.toolCallId, {});\n                    component.setExpanded(this.toolOutputExpanded);\n                    this.attachToolComponent(event.toolName, component);\n                    this.pendingTools.set(event.toolCallId, component);\n                }\n                this.toolResultReveal.finish(event.toolCallId);\n                component.updateResult({ ...event.result, isError: event.isError });\n                // 도구가 끝났으니 뭉침 줄의 숫자·색·diff 를 다시 그린다.\n                this.activeToolGroup?.refresh();\n                this.pendingTools.delete(event.toolCallId);",
    "attach tool result + refresh",
  );
  next = replaceOnce(
    next,
    "                    this.streamingComponent = undefined;\n                    this.streamingMessage = undefined;\n                }\n                this.detachAssistantTextSegments();\n                this.clearPendingTools();\n                this.ui.requestRender();\n                break;\n            case \"agent_settled\":",
    "                    this.streamingComponent = undefined;\n                    this.streamingMessage = undefined;\n                }\n                this.closeToolGroup();\n                // 포인터는 다음 agent_start 까지 둔다. abort 뒤에 오는 사고·도구가\n                // 새 뭉침을 열 때 요약에 안 실리면 Thought/도구 줄이 접히지 않는다.\n                // 턴이 끝나면 펼침을 되돌린다. ctrl+o 는 한 번 보려고 누르는 것이지\n                // 세션 내내 펼쳐두겠다는 뜻이 아니다.\n                if (this.toolOutputExpanded)\n                    this.setToolsExpanded(false);\n                this.detachAssistantTextSegments();\n                this.clearPendingTools();\n                this.chatContainer.markSettled();\n                this.ui.requestRender();\n                break;\n            case \"agent_settled\":",
    "agent_end close group + markSettled",
  );
  next = replaceOnce(
    next,
    "            case \"user\": {\n                const textContent = this.getUserMessageText(message);",
    "            case \"user\": {\n                const record = this.session.getInteractiveInput?.(message);\n                if (record?.delivery !== \"steer\") {\n                    this.turnWorkSummary?.setRequestCompleted?.(true, \"completed\");\n                    this.turnWorkSummary = undefined;\n                }\n                const textContent = this.getUserMessageText(message);",
    "user clears turn work",
  );
  next = replaceOnce(
    next,
    "            case \"assistant\": {\n                const assistantComponent = new AssistantMessageComponent(message, this.hideThinkingBlock, this.getMarkdownThemeWithSettings(), this.hiddenThinkingLabel, this.outputPad, this.getMarkdownTransformers());\n                assistantComponent.setExpanded(this.toolOutputExpanded);\n                this.chatContainer.addChild(assistantComponent);\n                break;\n            }",
    "            case \"assistant\": {\n                this.startTurnWorkSummary();\n                const assistantComponent = new AssistantMessageComponent(message, this.hideThinkingBlock, this.getMarkdownThemeWithSettings(), this.hiddenThinkingLabel, this.outputPad, this.getMarkdownTransformers());\n                assistantComponent.setExpanded(this.toolOutputExpanded);\n                this.chatContainer.addChild(assistantComponent);\n                this.turnWorkSummary?.trackAssistant(assistantComponent, message);\n                return assistantComponent;\n            }",
    "addMessageToChat assistant track",
  );
  next = replaceOnce(
    next,
    "            const runMessage = { ...message, content: runBlocks };\n            const existing = this.assistantTextSegments.get(runStart);\n            if (existing) {\n                existing.updateContent(runMessage, true);\n                continue;\n            }\n            const segment = new AssistantMessageComponent(runMessage, this.hideThinkingBlock, this.getMarkdownThemeWithSettings(), this.hiddenThinkingLabel, this.outputPad, this.getMarkdownTransformers());\n            segment.setExpanded(this.toolOutputExpanded);\n            this.assistantTextSegments.set(runStart, segment);\n            const followingToolCall = content.slice(index).find((block) => block.type === \"toolCall\");\n            const followingToolCallId = followingToolCall?.type === \"toolCall\" ? followingToolCall.id : undefined;\n            const followingToolComponent = followingToolCallId ? this.pendingTools.get(followingToolCallId) : undefined;\n            const anchorIndex = followingToolComponent ? this.chatContainer.children.indexOf(followingToolComponent) : -1;",
    "            const lastRunStart = lastAssistantTextRunStart(content);\n            const runMessage = {\n                ...message,\n                content: runBlocks,\n                stopReason: turnTailStopReason(message.stopReason, runStart === lastRunStart),\n            };\n            const existing = this.assistantTextSegments.get(runStart);\n            if (existing) {\n                existing.updateContent(runMessage, true);\n                this.turnWorkSummary?.trackAssistant(existing, runMessage);\n                continue;\n            }\n            const segment = new AssistantMessageComponent(runMessage, this.hideThinkingBlock, this.getMarkdownThemeWithSettings(), this.hiddenThinkingLabel, this.outputPad, this.getMarkdownTransformers());\n            segment.setExpanded(this.toolOutputExpanded);\n            this.assistantTextSegments.set(runStart, segment);\n            this.turnWorkSummary?.trackAssistant(segment, runMessage);\n            // 말이 끼었으니 열려 있던 뭉침은 여기서 끝난다. 닫지 않으면 이 말\n            // 뒤에 오는 도구가 말보다 위에 있는 앞 뭉침에 흡수돼서, 한 턴의\n            // 도구가 전부 맨 위 한 줄로 올라가고 말만 아래로 쌓인다.\n            this.closeToolGroup();\n            const followingToolCall = content.slice(index).find((block) => block.type === \"toolCall\");\n            const followingToolCallId = followingToolCall?.type === \"toolCall\" ? followingToolCall.id : undefined;\n            const followingToolComponent = followingToolCallId ? this.pendingTools.get(followingToolCallId) : undefined;\n            // 도구는 뭉침 안에 들어가 있을 수 있다. 그때 chatContainer 의 자식은\n            // 도구가 아니라 그 뭉침이므로, 앵커도 뭉침에서 찾아야 한다.\n            const anchor = followingToolComponent?.toolGroup ?? followingToolComponent;\n            const anchorIndex = anchor ? this.chatContainer.children.indexOf(anchor) : -1;",
    "trailing text run + group close",
  );
  next = replaceOnce(
    next,
    "        this.assistantTextSegments.clear();\n    }\n    createToolExecutionComponent(toolName, toolCallId, args) {\n        if (this.chrome) {\n            return new ToolExecutionComponent(toolName, toolCallId, args, {\n                showImages: this.settingsManager.getShowImages(),\n                imageWidthCells: this.settingsManager.getImageWidthCells(),\n            }, this.getRegisteredToolDefinition(toolName), this.ui, this.sessionManager.getCwd(), this.chrome.toolPresentation);\n        }\n        return new ToolExecutionComponent(toolName, toolCallId, args, {\n            showImages: this.settingsManager.getShowImages(),\n            imageWidthCells: this.settingsManager.getImageWidthCells(),\n        }, this.getRegisteredToolDefinition(toolName), this.ui, this.sessionManager.getCwd());\n    }\n    renderSessionItems(items, options = {}) {\n        this.clearPendingTools();",
    "        this.assistantTextSegments.clear();\n    }\n    /**\n     * 도구를 화면에 붙인다. 뭉칠 수 있는 도구는 직전 뭉침에 이어 붙이고,\n     * 아니면 새 뭉침을 연다. task/team_create/todo, SKILL.md read, git bash 는\n     * 뭉치지 않으므로 열려 있던 뭉침을 닫고 단독으로 붙인다.\n     */\n    attachToolComponent(toolName, component) {\n        if (!ToolGroupComponent.canGroup(toolName, component.args)) {\n            this.activeToolGroup = undefined;\n            this.chatContainer.addChild(component);\n            return;\n        }\n        if (!this.activeToolGroup) {\n            this.activeToolGroup = new ToolGroupComponent(this.ui);\n            this.activeToolGroup.setExpanded(this.toolOutputExpanded);\n            this.chatContainer.addChild(this.activeToolGroup);\n            this.turnWorkSummary?.trackToolGroup(this.activeToolGroup);\n        }\n        this.activeToolGroup.addTool(component);\n    }\n    /**\n     * args 가 늦게 와서 배치 뒤에야 스킬인 줄 알았을 때.\n     * 자기가 들어 있던 뭉침에서 빼서 단독으로 붙인다. 그룹이 비면 걷는다.\n     */\n    reconsiderToolGrouping(toolName, component) {\n        if (ToolGroupComponent.canGroup(toolName, component.args)) return;\n        const group = component.toolGroup;\n        if (!group) return;\n        const wasActive = this.activeToolGroup === group;\n        const next = group.extractAt(component, this.chatContainer.children, () => {\n            const created = new ToolGroupComponent(this.ui);\n            created.setExpanded(this.toolOutputExpanded);\n            this.turnWorkSummary?.trackToolGroup(created);\n            return created;\n        });\n        if (wasActive)\n            this.activeToolGroup = next;\n    }\n    /** 어시스턴트 텍스트나 턴 종료가 끼면 뭉침을 끊는다. */\n    closeToolGroup() {\n        this.activeToolGroup = undefined;\n    }\n    startTurnWorkSummary() {\n        if (this.turnWorkSummary)\n            return this.turnWorkSummary;\n        this.turnWorkSummary = new TurnWorkSummaryComponent(this.ui);\n        this.chatContainer.addChild(this.turnWorkSummary);\n        return this.turnWorkSummary;\n    }\n    createToolExecutionComponent(toolName, toolCallId, args) {\n        const component = this.chrome\n            ? new ToolExecutionComponent(toolName, toolCallId, args, {\n                showImages: this.settingsManager.getShowImages(),\n                imageWidthCells: this.settingsManager.getImageWidthCells(),\n            }, this.getRegisteredToolDefinition(toolName), this.ui, this.sessionManager.getCwd(), this.chrome.toolPresentation)\n            : new ToolExecutionComponent(toolName, toolCallId, args, {\n                showImages: this.settingsManager.getShowImages(),\n                imageWidthCells: this.settingsManager.getImageWidthCells(),\n            }, this.getRegisteredToolDefinition(toolName), this.ui, this.sessionManager.getCwd());\n        const originalUpdateArgs = component.updateArgs.bind(component);\n        component.updateArgs = (nextArgs) => {\n            originalUpdateArgs(nextArgs);\n            this.reconsiderToolGrouping(toolName, component);\n        };\n        return component;\n    }\n    renderSessionItems(items, options = {}) {\n        this.clearPendingTools();\n        this.turnWorkSummary = undefined;",
    "attach/close/startTurnWork + createTool wrap",
  );
  next = replaceOnce(
    next,
    "        const renderedPendingTools = new Map();\n        // Cache-miss notices are not persisted; re-derive them from the full entry",
    "        const renderedPendingTools = new Map();\n        const abortedPendingToolIds = new Set();\n        // Cache-miss notices are not persisted; re-derive them from the full entry",
    "abortedPendingToolIds",
  );
  next = replaceOnce(
    next,
    "            if (message.role === \"assistant\") {\n                this.addMessageToChat(message);\n                // Render tool call components\n                for (const content of message.content) {\n                    if (content.type === \"toolCall\") {\n                        const component = this.createToolExecutionComponent(content.name, content.id, content.arguments);\n                        component.setExpanded(this.toolOutputExpanded);\n                        this.chatContainer.addChild(component);\n                        if (message.stopReason === \"aborted\" || message.stopReason === \"error\") {\n                            let errorMessage;\n                            if (message.stopReason === \"aborted\") {\n                                errorMessage = abortedErrorLabel(message.errorMessage, this.session.retryAttempt);\n                            }\n                            else {\n                                errorMessage = message.errorMessage || \"Error\";\n                            }",
    "            if (message.role === \"assistant\") {\n                this.closeToolGroup();\n                this.turnWorkSummary = undefined;\n                // 첫 도구 앞의 머리말만 여기서 그린다. 그 뒤의 말은 도구 사이사이에\n                // 끼어 있으므로, 메시지를 통째로 그리면 한 턴의 말이 전부 도구 위로\n                // 올라가 순서가 뒤집힌다 — 스트리밍 경로와 같은 방식으로 갈라 그린다.\n                const firstToolIndex = message.content.findIndex((block) => block.type === \"toolCall\");\n                // 끝말(stopReason 꼬리표)은 마지막으로 그려지는 조각이 진다. 머리말에\n                // 남겨두면 \"출력이 잘렸다\" 같은 말이 도구들보다 앞에 나와 시간순이 어긋난다.\n                // 마지막 말 런이 시작하는 자리. 마지막 블록이 도구면 말 런이 없다.\n                let lastRunStart = -1;\n                if (firstToolIndex !== -1 && message.content[message.content.length - 1]?.type !== \"toolCall\") {\n                    lastRunStart = message.content.length - 1;\n                    while (lastRunStart > 0 && message.content[lastRunStart - 1]?.type !== \"toolCall\")\n                        lastRunStart -= 1;\n                }\n                // 말 런이 하나도 없으면(도구로 끝나면) 꼬리표를 받을 조각은 머리말뿐이다.\n                const tailReason = firstToolIndex === -1 || lastRunStart === -1 ? message.stopReason : \"stop\";\n                this.addMessageToChat(firstToolIndex === -1 ? message : { ...message, content: message.content.slice(0, firstToolIndex), stopReason: tailReason });\n                // Render tool call components\n                for (const [contentIndex, content] of message.content.entries()) {\n                    // 도구와 도구 사이의 말을 그 자리에 그리고 뭉침을 끊는다.\n                    if (content.type !== \"toolCall\") {\n                        if (firstToolIndex === -1 || contentIndex < firstToolIndex)\n                            continue;\n                        const runBlocks = [];\n                        let runIndex = contentIndex;\n                        while (runIndex < message.content.length && message.content[runIndex]?.type !== \"toolCall\") {\n                            const runBlock = message.content[runIndex];\n                            if (runBlock)\n                                runBlocks.push(runBlock);\n                            runIndex += 1;\n                        }\n                        // 이 런의 첫 블록에서만 그린다 — 뒤 블록은 이미 실려 있다.\n                        if (message.content[contentIndex - 1]?.type === \"toolCall\") {\n                            this.closeToolGroup();\n                            // 꼬리표는 마지막 런 하나만 진다. 중간 런까지 지우면 같은 오류가\n                            // 말 뚝이마다 다시 붙고, 아예 안 지우면 시간순이 뒤집힌다.\n                            const runReason = runIndex >= message.content.length && contentIndex === lastRunStart\n                                ? message.stopReason\n                                : \"stop\";\n                            this.addMessageToChat({ ...message, content: runBlocks, stopReason: runReason });\n                        }\n                        continue;\n                    }\n                    {\n                        const component = this.createToolExecutionComponent(content.name, content.id, content.arguments);\n                        component.setExpanded(this.toolOutputExpanded);\n                        this.attachToolComponent(content.name, component);\n                        if (message.stopReason === \"error\") {\n                            const errorMessage = message.errorMessage || \"Error\";",
    "renderSessionItems interleave",
  );
  next = replaceOnce(
    next,
    "                        else {\n                            renderedPendingTools.set(content.id, component);\n                        }",
    "                        else {\n                            renderedPendingTools.set(content.id, component);\n                            if (message.stopReason === \"aborted\")\n                                abortedPendingToolIds.add(content.id);\n                        }",
    "track aborted pending tools",
  );
  next = replaceOnce(
    next,
    "                this.addMessageToChat(message, options);\n            }\n        }\n        for (const [toolCallId, component] of renderedPendingTools) {\n            this.pendingTools.set(toolCallId, component);\n        }\n        this.ui.requestRender();",
    "                this.addMessageToChat(message, options);\n            }\n        }\n        for (const toolCallId of abortedPendingToolIds) {\n            const component = renderedPendingTools.get(toolCallId);\n            if (!component)\n                continue;\n            // No result: stop the spinner, but do not invent a success or abort\n            // payload. Real toolResult rows stay in the map and keep their text.\n            component.stopAnimation();\n            renderedPendingTools.delete(toolCallId);\n        }\n        for (const [toolCallId, component] of renderedPendingTools) {\n            this.pendingTools.set(toolCallId, component);\n        }\n        this.turnWorkSummary = undefined;\n        this.ui.requestRender();",
    "aborted pending + turn work clear",
  );
  next = replaceOnce(
    next,
    "//# sourceMappingURL=interactive-mode.js.map",
    "//# sourceMappingURL=interactive-mode.js.map\n",
    "interactive sourcemap newline",
  );

  return next;
}
