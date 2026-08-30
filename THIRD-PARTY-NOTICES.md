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

## Production npm dependencies of retained packages

These are declared `dependencies` of first-party packages under `packages/`, excluding nested skill `package.json` files.

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

## Inspiration-only (no source vendored)

`packages/rubato-runtime/plugin/skills/ulw-research/ATTRIBUTION.md` credits third-party research-skill ideas. That file states that no third-party source is copied there.
