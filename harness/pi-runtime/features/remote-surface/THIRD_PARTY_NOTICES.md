# remote-surface

Projection helpers and InteractiveActionDispatcher are reused from the current
product (`harness/rubato-pi/src/remote-conversation-projection.mjs` and
`interactive-control-surface.mjs`). `surface.mjs` is a stock-Pi port of
`harness/rubato-pi/src/extensions/remote-surface.mjs`: import paths are local,
and session metrics are a slim replacement because the product module pulls
Senpi statusline/TUI. The hub/protocol themselves stay in `packages/**`.
