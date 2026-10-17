import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ChatAttachment, ChatMessage } from "~/types";
import {
  fromEditableText,
  keptContext,
  plainTextOf,
  RubatoMessageEditor,
  toEditableText,
  withUploadedAttachments,
} from "./RubatoMessageEdit";

const link = (id: string, label = "image.png") => `![${label}](t3-context://v1/image/${id})`;
type ContextRecord = Parameters<typeof keptContext>[1][number];
const record = (value: object) => value as unknown as ContextRecord;
const image = (contextId: string, attachmentId: string) =>
  record({
    version: 1,
    contextId,
    label: "image.png",
    kind: "image",
    attachmentId,
    name: "image.png",
    mimeType: "image/png",
    sizeBytes: 1,
  });
const attachment = (id: string): ChatAttachment =>
  ({ type: "image", id, name: "image.png", mimeType: "image/png", sizeBytes: 1 }) as ChatAttachment;

describe("editing a sent message", () => {
  const text = `rewind는 ${link("image_a")} 코덱스처럼, ${link("image_b")} 포크도`;

  it("shows inline attachments as numbered placeholders and puts them back", () => {
    const editable = toEditableText(text);
    expect(editable.text).toBe("rewind는 ⟦image.png #1⟧ 코덱스처럼, ⟦image.png #2⟧ 포크도");
    const moved = "포크도 ⟦image.png #2⟧ 그리고 rewind는 ⟦image.png #1⟧ 수정";
    expect(fromEditableText(moved, editable.links)).toBe(
      `포크도 ${link("image_b")} 그리고 rewind는 ${link("image_a")} 수정`,
    );
    expect(fromEditableText("손으로 쓴 ⟦x #9⟧", editable.links)).toBe("손으로 쓴 ⟦x #9⟧");
  });

  it("drops the record and the attachment of a deleted placeholder", () => {
    const records = [image("image_a", "att-a"), image("image_b", "att-b")];
    const attachments = [attachment("att-a"), attachment("att-b"), attachment("att-loose")];
    const kept = keptContext(`only ${link("image_b")}`, records, attachments);
    expect(kept.records).toEqual([records[1]]);
    expect(kept.attachments.map((entry) => entry.id)).toEqual(["att-b", "att-loose"]);
  });

  it("moves records to the attachments uploaded again", () => {
    const moved = withUploadedAttachments(
      [image("image_a", "att-a"), record({ version: 1, contextId: "s", kind: "rubato-session" })],
      new Map([["att-a", "pending-new"]]),
    );
    expect((moved[0] as { attachmentId: string }).attachmentId).toBe("pending-new");
    expect(moved[1]).toEqual({ version: 1, contextId: "s", kind: "rubato-session" });
  });

  it("reduces links to labels for the composer", () => {
    expect(plainTextOf(text)).toBe("rewind는 image.png 코덱스처럼, image.png 포크도");
  });

  it("opens the bubble as an editor holding the text, with its images as placeholders", () => {
    const message = {
      id: "message-1",
      role: "user",
      text: `고쳐줘 ${link("image_a")}`,
      context: { version: 1, records: [image("image_a", "att-a")] },
      attachments: [attachment("att-a")],
      turnId: null,
      createdAt: "2026-10-15T00:00:00.000Z",
      updatedAt: "2026-10-15T00:00:00.000Z",
      streaming: false,
    } as unknown as ChatMessage;
    const html = renderToStaticMarkup(
      <RubatoMessageEditor threadKey="thread" message={message} />,
    );
    expect(html).toContain("고쳐줘 ⟦image.png #1⟧</textarea>");
    expect(html).toContain(">Cancel<");
    expect(html).toContain(">Send<");
  });
});
