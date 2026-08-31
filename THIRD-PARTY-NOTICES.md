# Third Party Notices

This file records third-party source retained in the Rubato workspace and the
production npm dependencies of retained first-party packages.

Copied or derived source keeps its original license and attribution. Skill-level
license text lives next to that source. Payloads that are no longer in the tree
are omitted.

Update this list whenever Rubato adds, removes, or replaces a bundled component
or a retained package production dependency.

## Copied or derived source

### pi-lsp-client
- License: MIT, from `packages/rubato-runtime/plugin/LICENSE` and package NOTICE files.
- Copyright: Yeongyu Kim.
- Upstream URL: https://github.com/code-yeongyu
- Where-bundled: adapted LSP engine in `packages/lsp-core`; Senpi adapter descriptor, schema, renderer, path extraction, post-edit wiring, and migration-warning helpers in `packages/rubato-runtime`; runtime execution is packaged by `@rubato/lsp-daemon`. See `packages/lsp-core/NOTICE`, `packages/lsp-daemon/NOTICE`, and `packages/rubato-runtime/plugin/NOTICE`.

### ast-grep-skill
- License: MIT, from `packages/rubato-runtime/plugin/skills/ast-grep/LICENSE`.
- Copyright: Yeongyu Kim.
- Upstream URL: https://github.com/code-yeongyu/ast-grep-skill
- Where-bundled: vendored skill sync recorded in `packages/rubato-runtime/plugin/skills/ast-grep/SOURCE` (ast-grep 0.45.0 @ 3148c69).

### Open Design
- License: Apache-2.0, from `packages/rubato-runtime/plugin/skills/frontend/LICENSE-Apache-2.0.txt`.
- Copyright: Copyright 2026 Open Design contributors.
- Upstream URL: https://github.com/nexu-io/open-design
- Where-bundled: brand design-system reference files under `packages/rubato-runtime/plugin/skills/frontend/references/design/`. Full notices: `packages/rubato-runtime/plugin/skills/frontend/ATTRIBUTION.md`.

### taste-skill
- License: MIT.
- Copyright: Copyright (c) 2026 Leonxlnx.
- Upstream URL: https://github.com/Leonxlnx/taste-skill
- Where-bundled: taste and image-generation skill files under `packages/rubato-runtime/plugin/skills/frontend/references/design/`. Full notices: `packages/rubato-runtime/plugin/skills/frontend/ATTRIBUTION.md`.

### UI/UX Pro Max
- License: MIT.
- Copyright: Copyright (c) 2024 Next Level Builder.
- Upstream URL: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
- Where-bundled: search engine and dataset under `packages/rubato-runtime/plugin/skills/frontend/references/ui-ux-db/`. Full notices: `packages/rubato-runtime/plugin/skills/frontend/ATTRIBUTION.md`.

### designpowers
- License: MIT, from `packages/rubato-runtime/plugin/skills/frontend/references/designpowers/vendor/LICENSE`.
- Copyright: Copyright (c) 2026 MC Dean.
- Upstream URL: https://github.com/Owl-Listener/designpowers
- Where-bundled: selected agents and skill references under `packages/rubato-runtime/plugin/skills/frontend/references/designpowers/vendor/`. Full notices: `packages/rubato-runtime/plugin/skills/frontend/ATTRIBUTION.md`.

### insane-search
- License: not present in the vendored snapshot. Treat `engine/**` as upstream-derived; do not infer project-original licensing from the missing file.
- Copyright: insane-search / fivetaku upstream authors, plus later Rubato modifications.
- Upstream URL: https://github.com/fivetaku/insane-search
- Where-bundled: `packages/rubato-runtime/plugin/skills/ultimate-browsing/engine/`. Full notices: `packages/rubato-runtime/plugin/skills/ultimate-browsing/ATTRIBUTION.md`.

### zmx
- License: MIT, full text at `third_party/zmx/LICENSE`.
- Copyright: Copyright (c) 2025 Eric Bower.
- Upstream URL: https://github.com/neurosnap/zmx
- Where-bundled: architecture-specific Rubato Remote process-lifecycle binary built from commit `0266042ca8f399c9d76825739b93443e2d5bf47a`; checksums and build inputs are pinned in `third_party/zmx-lock.json`.

## Production npm dependencies of retained packages

These are declared `dependencies` of first-party packages under `packages/`, excluding nested skill `package.json` files. The complete transitive lockfile policy is machine-validated from `third_party/npm-license-policy.json`.

### @earendil-works/pi-tui@0.84.2
- License: MIT, from package metadata. The inspected package did not include a separate LICENSE file.
- Copyright: Mario Zechner and pi contributors.
- Upstream URL: https://github.com/earendil-works/pi/tree/main/packages/tui
- Where-bundled: `@rubato/runtime` production dependency.

### js-yaml@5.3.0
- License: MIT, from `node_modules/js-yaml/LICENSE`.
- Copyright: Copyright (C) 2011-2015 Vitaly Puzrin.
- Upstream URL: https://github.com/nodeca/js-yaml
- Where-bundled: `@rubato/utils` production dependency.

### jsonc-parser@3.3.1
- License: MIT, from `node_modules/jsonc-parser/LICENSE.md`.
- Copyright: Copyright (c) Microsoft.
- Upstream URL: https://github.com/microsoft/node-jsonc-parser
- Where-bundled: `@rubato/utils` and `@rubato/config-core` production dependency.

### typebox@1.3.16
- License: MIT, from the typebox package `license` file.
- Copyright: Copyright (c) 2017-2026 Haydn Paterson.
- Upstream URL: https://github.com/sinclairzx81/typebox
- Where-bundled: `@rubato/runtime` and `@rubato/senpi-task` production dependency.

### zod@4.4.3
- License: MIT, from `node_modules/zod/LICENSE`.
- Copyright: Copyright (c) 2025 Colin McDonnell.
- Upstream URL: https://github.com/colinhacks/zod
- Where-bundled: `@rubato/config-core` and `@rubato/team-core` production dependency.

### @git-diff-view/react@0.1.7
- License: MIT. Copyright: MrWangJustToDo and contributors.
- Upstream URL: https://github.com/MrWangJustToDo/git-diff-view
- Where-bundled: Rubato Remote web diff viewer.

### @hono/node-server@1.19.17
- Security pin: exact 1.19.17 intentionally supersedes the vulnerable 1.19.13 design reference; reviewed advisory and audit evidence are recorded in `third_party/hono-security-deviation.md`.
- License: MIT. Copyright: Yusuke Wada and Hono contributors.
- Upstream URL: https://github.com/honojs/node-server
- Where-bundled: Rubato Remote localhost hub.

### @tanstack/react-query@5.102.8
- License: MIT. Copyright: TanStack Query contributors.
- Upstream URL: https://github.com/TanStack/query
- Where-bundled: Rubato Remote web client state synchronization.

### @xterm/addon-fit@0.10.0
- License: MIT. Copyright: The xterm.js authors.
- Upstream URL: https://github.com/xtermjs/xterm.js
- Where-bundled: Rubato Remote emergency terminal sizing.

### @xterm/xterm@5.5.0
- License: MIT. Copyright: The xterm.js authors.
- Upstream URL: https://github.com/xtermjs/xterm.js
- Where-bundled: Rubato Remote emergency terminal.

### hono@4.13.5
- Security pin: exact 4.13.5 intentionally supersedes the vulnerable 4.12.18 design reference; reviewed HIGH/MODERATE advisories and audit evidence are recorded in `third_party/hono-security-deviation.md`.
- License: MIT. Copyright: Yusuke Wada and Hono contributors.
- Upstream URL: https://github.com/honojs/hono
- Where-bundled: Rubato Remote localhost HTTP API.

### idb@8.0.3
- License: ISC. Copyright: Jake Archibald.
- Upstream URL: https://github.com/jakearchibald/idb
- Where-bundled: Rubato Remote browser host registry.

### konsta@5.4.0
- License: MIT. Copyright: Vladimir Kharlampidi and contributors.
- Upstream URL: https://github.com/konstaui/konsta
- Where-bundled: Rubato Remote iOS-style web interface.

### react@19.2.6
- License: MIT. Copyright: Meta Platforms, Inc. and affiliates.
- Upstream URL: https://github.com/facebook/react
- Where-bundled: Rubato Remote web interface.

### react-dom@19.2.6
- License: MIT. Copyright: Meta Platforms, Inc. and affiliates.
- Upstream URL: https://github.com/facebook/react
- Where-bundled: Rubato Remote web interface renderer.

### streamdown@2.5.0
- License: Apache-2.0. Copyright: Vercel, Inc. and contributors.
- Upstream URL: https://github.com/vercel/streamdown
- Where-bundled: Rubato Remote streamed Markdown rendering.

### tailwindcss@4.3.0
- License: MIT. Copyright: Tailwind Labs, Inc.
- Upstream URL: https://github.com/tailwindlabs/tailwindcss
- Where-bundled: Rubato Remote web styles.

### web-push@3.6.7
- License: MPL-2.0; used unmodified. Copyright: Marco Castelluccio and contributors.
- Upstream URL: https://github.com/web-push-libs/web-push
- Where-bundled: Rubato Remote hub push transport.

### ws@8.21.3
- License: MIT. Copyright: Einar Otto Stangvik and contributors.
- Upstream URL: https://github.com/websockets/ws
- Where-bundled: Rubato Remote hub WebSocket transport.

### zustand@5.0.14
- License: MIT. Copyright: Paul Henschel and contributors.
- Upstream URL: https://github.com/pmndrs/zustand
- Where-bundled: Rubato Remote web client state.

### node-pty@1.1.0
- License: MIT. Copyright: Microsoft Corporation and contributors.
- Upstream URL: https://github.com/microsoft/node-pty
- Where-bundled: optional, explicitly enabled fallback for the Rubato Remote emergency terminal; the Bun PTY bridge remains the default.

## Inspiration-only (no source vendored)

`pi-web-ui` 0.1.1 (MIT, https://github.com/kkkiio/pi-web-ui) informed reducer and interaction concepts. No pi-web-ui source is bundled.

`packages/rubato-runtime/plugin/skills/ulw-research/ATTRIBUTION.md` credits third-party research-skill ideas. That file states that no third-party source is copied there.
