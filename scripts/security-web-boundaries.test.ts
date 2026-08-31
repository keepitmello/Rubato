import { expect, test } from "bun:test"
import React from "../packages/rubato-remote-web/node_modules/react/index.js"
import { renderToStaticMarkup } from "../packages/rubato-remote-web/node_modules/react-dom/server.node.js"
import { Conversation } from "../packages/rubato-remote-web/src/components/Conversation.js"

Object.defineProperty(globalThis, "location", { value: new URL("https://phone.example.ts.net/rubato/"), configurable: true })

test("malicious Markdown cannot create raw HTML or javascript links", () => {
  const html = renderToStaticMarkup(React.createElement(Conversation, { entries: [{
    kind: "message",
    id: "message-1",
    role: "assistant",
    text: '<img src=x onerror="globalThis.pwned=true"> [run](javascript:alert(1))',
    streaming: false,
  }] }))
  expect(html).not.toContain("onerror")
  expect(html).not.toContain("javascript:")
  expect(html).not.toContain("<img src=x")
  expect(html.length).toBeGreaterThan(0)
})

test("malicious diff/tool filenames and output remain escaped plain text", () => {
  const payload = '</pre><script>globalThis.pwned=true</script><img src=x onerror=alert(1)>.diff'
  const html = renderToStaticMarkup(React.createElement(Conversation, { entries: [{
    kind: "tool",
    id: "tool-1",
    name: payload,
    status: "failed",
    summary: payload,
    output: payload,
  }] }))
  expect(html).not.toContain("<script>")
  expect(html).not.toContain("<img src=x")
  expect(html).toContain("&lt;script&gt;")
})
