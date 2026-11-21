import type { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { avatarEdge, clampOffset, cropRect, roomPictures } from "./pictureModel";

const landscape = { width: 4000, height: 3000 };

describe("placing a picture in the circle", () => {
  it("takes the middle square when the person moves nothing", () => {
    expect(cropRect(landscape, 300, 1, { x: 0, y: 0 })).toEqual({ originX: 500, originY: 0, width: 3000, height: 3000 });
  });

  it("follows the picture: moved right, the circle shows more of its left", () => {
    // At zoom 1, 300 points span 3000 pixels: 10 pixels a point.
    expect(cropRect(landscape, 300, 1, { x: 20, y: 0 })).toEqual({ originX: 300, originY: 0, width: 3000, height: 3000 });
  });

  it("keeps the circle covered however far the picture is dragged", () => {
    expect(clampOffset(landscape, 300, 1, { x: 999, y: 50 })).toEqual({ x: 50, y: 0 });
    expect(cropRect(landscape, 300, 1, { x: 999, y: -999 })).toEqual({ originX: 0, originY: 0, width: 3000, height: 3000 });
  });

  it("zooms into a smaller square, and never past the picture's edge", () => {
    expect(cropRect(landscape, 300, 2, { x: 0, y: 0 })).toEqual({ originX: 1250, originY: 750, width: 1500, height: 1500 });
    expect(cropRect(landscape, 300, 2, { x: -400, y: 400 })).toEqual({ originX: 2500, originY: 0, width: 1500, height: 1500 });
    expect(cropRect(landscape, 300, 50, { x: 0, y: 0 }).width).toBe(600);
  });

  it("sends at most 1024 pixels a side", () => {
    expect(avatarEdge({ originX: 0, originY: 0, width: 3000, height: 3000 })).toBe(1024);
    expect(avatarEdge({ originX: 0, originY: 0, width: 400, height: 400 })).toBe(400);
  });
});

describe("pictures in the conversation", () => {
  const thread = "thread-1" as ThreadId;
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 21, 3, minutes)).toISOString();
  it("lists sent pictures and the companion's picture files, newest first, each once", () => {
    const pictures = roomPictures(
      [
        { id: "a", role: "user", text: "이거 어때", createdAt: at(1),
          attachments: [{ type: "image", id: "att-1", name: "me.jpg", mimeType: "image/jpeg", sizeBytes: 10 },
            { type: "file", id: "att-2", name: "notes.txt", mimeType: "text/plain", sizeBytes: 10 }] },
        { id: "b", role: "assistant", text: "그려봤어\n\n![세뇨](</Users/x/art/draw.png>)\n\n[보고서](</Users/x/report.pdf>)", createdAt: at(2) },
        { id: "c", role: "assistant", text: "다시\n\n![세뇨](</Users/x/art/draw.png>)\n\n![영상](</Users/x/clip.mp4>)", createdAt: at(3) },
      ],
      thread,
    );
    expect(pictures).toEqual([
      { key: "file:/Users/x/art/draw.png", resource: { _tag: "media-file", threadId: thread, path: "/Users/x/art/draw.png" } },
      { key: "attachment:att-1", resource: { _tag: "attachment", attachmentId: "att-1", fileName: "me.jpg", mimeType: "image/jpeg", disposition: "inline" } },
    ]);
  });
});
