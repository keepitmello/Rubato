# removed-tool-hints.patch — pi-agent-core 0.84.2

Stock `@earendil-works/pi-agent-core@0.84.2`. Additive. Does not wrap streams
(provider owner) and does not copy fork `agent-loop.js`.

## What

- `Agent.removedToolHints` (`Record<string, string>`), optional on `AgentOptions`.
- `createLoopConfig()` forwards `removedToolHints`.
- `prepareToolCall`: unknown tool result is `Tool X not found. ${hint}` when a hint exists.

Coding-agent `session-core-extension.patch` writes hints from
`registerRemovedToolHint` onto `this.agent.removedToolHints`.

## Order

Apply on unpacked pi-agent-core 0.84.2 (e.g. nested under stock coding-agent).
Independent of empty-assistant-recovery-export except both patch `agent-loop.js` —
if both apply, lead must order: this patch first (unknown-tool hunk), recovery
export second (if it does not overlap this hunk).
