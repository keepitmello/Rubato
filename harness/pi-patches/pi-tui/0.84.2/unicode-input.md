# unicode-input.patch — provenance and metadata

## What

Carries the Senpi split-byte/astral input delta onto stock
`@earendil-works/pi-tui@0.84.2`, file `dist/stdin-buffer.js` only.
Upstream terminal/editor implementation is otherwise preserved untouched.

## Provenance

- Stock source: `@earendil-works/pi-tui@0.84.2`, MIT (Mario Zechner,
  `github.com/earendil-works/pi`, `packages/tui`), registry tarball.
  The tarball has no LICENSE file; MIT is package metadata. stdin-buffer.js
  also records OpenTUI (`MIT License - Copyright (c) 2025 opentui`).
- Delta source: installed `@code-yeongyu/senpi-tui@2026.9.4-3`
  (`node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-tui/dist/stdin-buffer.js`),
  also MIT-declared. Only the 4 functional hunks below were carried; the whole
  fork file was NOT copied. Comment wording is ours; semantics match the proven
  fork behavior.
- Related finding: `pi-cutover-ui-manifest.md` rows A1 (unicode) — this patch.
- NOTICE: retained fixture + this derived patch are recorded in the isolated
  root `THIRD-PARTY-NOTICES.md`. A NOTICE addition **is** required.

## Hunks (4, `dist/stdin-buffer.js`)

1. `import { StringDecoder } from "node:string_decoder"` (+ class field
   `decoder`, reset in `clear()`).
2. `splitSequences` non-escape branch: `codePointAt`/`fromCodePoint` so astral
   characters (emoji) emit as one sequence instead of two lone surrogates.
   Necessary on the production path: `ProcessTerminal` sets
   `stdin.setEncoding("utf8")`, so strings arrive whole but were still split.
3. `process()` Buffer path: `StringDecoder.write` holds a split multibyte tail
   across `process()` calls instead of emitting U+FFFD; single bytes
   `0x80–0xC1` outside a sequence keep the legacy parseKeypress
   ESC+(byte-128) mapping; bytes `>= 0xC2` go to the decoder as potential
   multibyte leads. Empty decoder output suppresses the empty `data` event.
4. `clear()` resets the decoder so no ghost bytes leak across resets.

## Application

From the extracted `@earendil-works/pi-tui-0.84.2` package root. Apple/BSD
`patch` prompts on `/dev/tty`; always pass `--batch --forward` and a
subprocess timeout:

```
patch -p1 --fuzz=0 --batch --forward < harness/pi-patches/pi-tui/0.84.2/unicode-input.patch
```

`--fuzz=0` rejects **context** mismatch (wrong neighboring lines). It does
**not** reject line-number **offsets**. Do not read a clean fuzz-0 apply as
"no drift of any kind."

## Drift policy

`harness/rubato-pi/test/unit/pi-unicode-input.test.mjs`:

- (a) fuzz-0 `--batch --forward` apply on the pristine fixture
  (`test/fixtures/pi-tui-0.84.2-stdin-buffer.js`, verbatim upstream copy)
  with the first inserted import pinned at line 19 (offset apply on this
  fixture fails that pin);
- (b) mutating a pristine hunk anchor must fail the apply (real context
  reject, not second-apply detection);
- (c) the pristine fixture must still exhibit U+FFFD on split Korean
  (upstream fixed it — then this patch and fixture retire together).

Recut the patch if context changes. Never widen fuzz.

## License

Stock file: MIT (upstream, Mario Zechner / pi contributors; OpenTUI 2025
notice in-file). Delta: MIT-compatible, no new dependency
(`node:string_decoder` is core). Full notices: root `THIRD-PARTY-NOTICES.md`.
