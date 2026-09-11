# Provider feature third-party notices

The Cursor provider, OAuth flow, HTTP/2 transport, protobuf bindings, catalog
helpers, and local-work event stream in `vendor/pi-ai` are selected files from
`@earendil-works/pi-ai@2026.9.4-3`, published with
`@code-yeongyu/senpi@2026.9.4-3`. The package declares the MIT license and
attributes its author as Mario Zechner. The generated Cursor protobuf file
retains its source attribution to the upstream oh-my-pi
`packages/ai/proto/cursor/agent.proto`.

MIT License

Copyright (c) Mario Zechner and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

`@bufbuild/protobuf@2.14.0` is used by the Cursor transport. Its package
license expression is `(Apache-2.0 AND BSD-3-Clause)`; it is installed and
locked by the standalone runtime rather than copied into this feature.

The credential-pool modules under `features/providers/auth-pool/` are derived
from `@code-yeongyu/senpi@2026.9.4-3` (MIT), specifically
`dist/core/credential-pool/*`, `dist/core/credential-accounts.js`,
`dist/core/extensions/builtin/account/index.js`, and nested
`@earendil-works/pi-ai/dist/auth/pool/{slots,select}.js`. The MIT text above
covers that derivation.
