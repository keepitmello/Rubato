# Third-party notices

The per-model prompt-preset factory preserves a bounded subset of behavior from
`@code-yeongyu/senpi` 2026.9.4-3 (`dist/core/extensions/builtin/prompt-preset/`).
Its installed `package.json` declares the MIT license. The published package does
not include a root license file; this license text was checked against the license
shipped by `@code-yeongyu/senpi-codemode` 2026.9.4-3 from the same source repository
and release.

File-operations, execution-tooling, and gpt-eval-routing strings, plus model-id
resolution in `presets.mjs`, are derived from that builtin. Stock Pi 0.85.1 is
the runtime owner of prompt assembly; this feature only injects a tuning block
through the public `before_agent_start` return.

> Copyright (c) 2025 Mario Zechner (upstream pi-mono)
>
> Copyright (c) 2026 Yeongyu Kim and senpi contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
