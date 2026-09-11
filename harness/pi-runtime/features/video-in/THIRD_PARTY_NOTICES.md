# Video-in provenance

The `src/index.mjs` tool is adapted from the compiled runtime in
`@code-yeongyu/senpi@2026.9.4-3` (`dist/core/extensions/builtin/video-in/index.js`,
npm integrity
`sha512-9crNMupK8ic5Qu7aCHPf3bDBu0jczo1Gv0eCxJNA1HTLi1RapwCzp7UMwYhXdSJsajeQSeGsZ5FTw9kuQOXoFw==`).
That package is MIT licensed. Its repository license is preserved as `LICENSE` (SHA-256
`b572487f123bf259487f7dab25923af16fecd08ed7a2c50964f393282dba883c`).

The anthropic-messages video-block serialization is adapted from
`@code-yeongyu/senpi-ai@2026.9.4-3` (npm integrity
`sha512-ajUzHkmNvymthjTcQA8fyIWd8f4PgE5GdsgBlo2t+Ai6E2ddNyZTBe0pVwTqii6eMI6FbasWKqGkgz6L+T/eFg==`).
Stock Pi 0.85.1 has no `video` member on `Model.input` and the bundled kimi-coding
catalog lists k3 as `text,image` only. This feature owns the video-capable model
registry and a minimal anchored patch so `video/*` ImageContent blocks serialize as
`{type:"video", source:{type:"base64", media_type, data}}`.

No Senpi package is loaded at runtime. `typebox@1.3.18` is already a runtime
direct dependency.
