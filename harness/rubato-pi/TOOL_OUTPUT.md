# Direct tools and bounded model-facing output

Ordinary tools are available directly; eval remains an optional persistent
computation surface. `core-agent-session.mjs` clears the installed engine's
default eval-only name set at load time. Explicit SDK overrides still work.
The installed package is not modified.

Terminal instructions follow actual active-tool exposure, not mere eval
registration. Bash and monitor are checked independently so partial SDK
overrides keep accurate call examples. `core-terminal-routing.mjs` adapts this
installed-engine prompt path; the bash/monitor tool descriptions themselves
already describe direct calls.

## Output boundary

`tool-output-policy.mjs` contains the engine-independent preview policy.
`extensions/tool-output.mjs` connects it through the pi-compatible `context`
hook. No model call, command rewrite, or eval wrapper is added.

- Successful bash, powershell, eval, edit/write and supported search-tool text
  blocks over 16 KiB get an 8 KiB preview, plus a recovery notice.
- Search previews retain the head; other previews retain head and tail.
- Read results, failed results, unknown tools, images and metadata stay intact.
- Tool execution, eval's internal bridge values, UI and saved messages are not
  modified. Only provider-bound messages are projected.
- Original **received tool-result text** is persisted under the session's
  `-artifacts/tool-output/<sha256>.txt` directory, with mode 0600. If a tool has
  already truncated its output, this layer cannot recover the removed part;
  existing upstream recovery pointers remain in the saved text.
- Recovery uses ordinary `read` with offset/limit; those reads are exempt.
- Small blocks do no artifact IO. Stored-file metadata caching is bounded and
  reset on session start/shutdown; cached files are stat-checked before reuse.
  Deleted artifacts are recreated and modified ones are not advertised.
  Stable content-addressed paths keep previews stable
  between turns. Failed storage leaves the original block untouched.
- Artifacts follow session ownership, with no independent TTL that could expire
  pointers in an old session. This adds disk usage; no global cleanup is installed.
- Limits apply per text block, not to the whole request. This is deliberately
  not a global context pruner or semantic test-log summarizer.

The policy is ordinary Node-compatible JavaScript. Only the small registration
module knows the session API. The future pi core / senpi adapter / Rubato adapter
split needs no new framework for this feature.

## Research decision (2026-09-06)

Aside surveyed pi, OpenCode, Codex, RTK and context-mode. No dependency was added
and no upstream code was copied. The lead rechecked the OpenCode truncation
source and RTK/context-mode licenses.

- [OpenCode truncation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/truncate.ts):
  bounded preview plus saved full text. This is the relevant pattern. Its
  seven-day TTL is not copied because our pointers are session-owned.
- [RTK](https://github.com/rtk-ai/rtk):
  useful command-specific filtering, but command rewriting is not part of this
  change. [License](https://github.com/rtk-ai/rtk/blob/develop/LICENSE) is Apache-2.0.
- [context-mode](https://github.com/mksglu/context-mode):
  execution/indexing is a different default path than direct native tools.
  [License](https://github.com/mksglu/context-mode/blob/main/LICENSE) is Elastic
  2.0, with hosted-service restrictions. Not adopted.

Marketing compression ratios are not evidence of task-level savings. A local
synthetic fixture (`start\n` + 4,000 `output line\n` + `end\n`) shrinks from
48,010 to 8,427 bytes with a short example artifact path: 82.4% fewer bytes.
Actual preview length depends on the path. This is not a token, latency, billing,
or task-quality benchmark.

## Verification

Run from `harness/rubato-pi`:

```sh
node --import ./src/no-changelog-register.mjs --test --test-concurrency=1 \
  test/unit/tool-output.test.mjs \
  test/unit/tool-context-integration.test.mjs \
  test/unit/adapter-contract.test.mjs \
  test/unit/eval-only-direct-tools.test.mjs \
  test/unit/eval-prompt.test.mjs \
  test/unit/terminal-routing-prompt.test.mjs \
  test/unit/control-codemode-redirect.test.mjs \
  test/unit/system-prompt.test.mjs \
  test/unit/core-overflow.test.mjs \
  test/unit/prompt-drift.test.mjs \
  test/unit/installed-engine-transforms.test.mjs
```

Integration tests invoke the installed transformed AgentSession and
ExtensionRunner methods (no paid model request): direct tool visibility, explicit
SDK override, bridge hooks, hook denial, raw bridge preservation, provider-only
preview and exact artifact round-trip.

Serial test-file execution avoids an existing shared engine-symlink initialization
race. LSP diagnostics were unavailable: daemon startup reported
`owner_changed_during_cleanup`. Use syntax checks and the tests above; this change
does not repair that unrelated daemon.

Final run: **61 passed, 0 failed**, exit code 0 (including terminal routing and
actual tool-description checks). Independent output review found
a stale cached-artifact pointer after external deletion; metadata checks and two
regression tests now cover deletion and modification during the same session.

Separate check: `node --test test/unit/role-prompt.test.mjs` returned exit code 1,
10 passed / 2 failed. The unmodified model-guide skill and role-prompt test
disagree over the exact wording of `model`/`preset` instructions. Neither file
was changed for this task. Full paid-model behavior, task latency and end-to-end
token savings were not measured. Restart/reload the harness to load these changes;
the running session's already-advertised tool schema is not hot-swapped here.
