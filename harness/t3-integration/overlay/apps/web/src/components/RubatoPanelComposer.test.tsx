import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RubatoPanelComposer } from "./RubatoPanelComposer";

const base = {
  onChange: () => undefined,
  onSend: () => undefined,
  placeholder: "Ask in this side chat…",
  ariaLabel: "Message to this side chat",
};

const disabledButton = (html: string, label: string) =>
  new RegExp(`<button[^>]*disabled=""[^>]*aria-label="${label}"`).test(html);

describe("RubatoPanelComposer", () => {
  it("wears the thread composer's surface and round send button", () => {
    const html = renderToStaticMarkup(<RubatoPanelComposer {...base} value="" hint="Same model as the thread" />);
    expect(html).toContain('data-slot="composer-shell"');
    expect(html).toContain('data-chat-composer-main-surface="true"');
    expect(html).toContain('aria-label="Message to this side chat"');
    expect(html).toContain("Same model as the thread");
    // Nothing written yet: the send button is there but cannot send.
    expect(disabledButton(html, "Send message")).toBe(true);
    expect(html).not.toContain("Stop generation");
  });

  it("a written draft can be sent", () => {
    const html = renderToStaticMarkup(<RubatoPanelComposer {...base} value="why?" />);
    expect(html).toContain('aria-label="Send message"');
    expect(disabledButton(html, "Send message")).toBe(false);
  });

  it("while the conversation runs it offers Stop, and Send only when the draft can go", () => {
    const stop = () => undefined;
    const held = renderToStaticMarkup(
      <RubatoPanelComposer {...base} value="next" running onStop={stop} canSend={false} />,
    );
    expect(held).toContain('aria-label="Stop generation"');
    expect(held).not.toContain("Queue message");

    const told = renderToStaticMarkup(<RubatoPanelComposer {...base} value="next" running onStop={stop} />);
    expect(told).toContain('aria-label="Stop generation"');
    expect(told).toContain('aria-label="Queue message"');
  });

  it("shows what went wrong above the surface", () => {
    const html = renderToStaticMarkup(<RubatoPanelComposer {...base} value="" error="Session is gone" />);
    expect(html).toContain("Session is gone");
  });
});
