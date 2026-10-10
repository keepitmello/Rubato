# Media tools provenance

The `src/webfetch/`, `src/look-at/`, and `src/imagegen/` implementations are adapted from the compiled
runtime and embedded TypeScript sources distributed in `@code-yeongyu/senpi@2026.9.4-3` (npm integrity
`sha512-9crNMupK8ic5Qu7aCHPf3bDBu0jczo1Gv0eCxJNA1HTLi1RapwCzp7UMwYhXdSJsajeQSeGsZ5FTw9kuQOXoFw==`).
That package is MIT licensed. Its repository license is preserved as `LICENSE` (SHA-256
`b572487f123bf259487f7dab25923af16fecd08ed7a2c50964f393282dba883c`).

Only package/host boundaries changed. Stock Pi's public tool, settings, image, model
completion, and rendering exports replace Senpi-internal paths. The small
`src/host/model-resolver.mjs` preserves the exact matching subset used by look_at because
those helpers are not package-root exports; `src/host/image-process.mjs` composes stock
public image conversion/resize exports. Webfetch's network, redirect, timeout, size-cap,
conversion, rendering, and activation logic remains the distributed implementation. No Senpi package is loaded at runtime.

The exact runtime dependencies are `undici@8.10.0` (MIT), `jsdom@30.0.1` (MIT),
`@mozilla/readability@0.6.0` (Apache-2.0), and `turndown@7.2.4` (MIT). Dependency
packages retain their own license files in the standalone installation.
