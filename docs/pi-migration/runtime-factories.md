# Runtime-bound extension factories

> HISTORICAL EVIDENCE — 2026-09-08: 이 문서는 작성 당시 기능별 구현/검증 기록입니다. 현재 상태·남은 문제·다음 순서의 정본은 lab의 [pi-migration-ssot.md](../../../../case-studies/runtime-migration/pi-migration-ssot.md)입니다. 아래 완료/계획 표현은 그 시점과 범위에 한정하며 현재 전체 통과를 뜻하지 않습니다.

The `runtime-factories` Pi 0.85.1 feature adds one narrow callback seam to the
stock CLI and service factory. `main(args, { createExtensionFactories })` forwards
the callback to `createAgentSessionServices`. Services first resolve the canonical
`ModelRuntime` and `SettingsManager`, then invoke the callback with those exact
objects and the resolved `cwd`/`agentDir`, before constructing
`DefaultResourceLoader`.

The callback result is merged after any static
`resourceLoaderOptions.extensionFactories`. It must be an array; callback errors
and invalid results propagate to the caller. No global Senpi selection or second
model runtime is created. Session/cwd replacement re-enters the stock service
factory, so each replacement receives its own canonical context.

This is a staged exact-hash patch for `@earendil-works/pi-coding-agent@0.85.1`;
the installed package is not modified. Parent Rubato bootstrap code should pass
only the feature set intended for that process (for example, child RPCs retain
their existing explicit provider-extension contract rather than inheriting the
entire parent assembly).
