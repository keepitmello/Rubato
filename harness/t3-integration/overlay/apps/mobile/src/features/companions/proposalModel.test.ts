import { describe, expect, it } from "vite-plus/test";

import { compactDiff, decodeProposals, wordDiff } from "./proposalModel";

describe("a change card's diff", () => {
  it("marks only the words that changed, keeping the spacing as written", () => {
    const before = "내 말은 한국어 반말이고 짧아. 보통 한두 줄, 길어도 서너 줄.";
    const after = "내 말은 한국어 반말이고 짧아. 보통 한 줄, 길어도 두 줄.";
    const diff = wordDiff(before, after);
    expect(diff).toEqual([
      { kind: "same", text: "내 말은 한국어 반말이고 짧아. 보통 " },
      { kind: "del", text: "한두" },
      { kind: "ins", text: "한" },
      { kind: "same", text: " 줄, 길어도 " },
      { kind: "del", text: "서너" },
      { kind: "ins", text: "두" },
      { kind: "same", text: " 줄." },
    ]);
    expect(diff.filter((part) => part.kind !== "ins").map((part) => part.text).join("")).toBe(before);
    expect(diff.filter((part) => part.kind !== "del").map((part) => part.text).join("")).toBe(after);
  });

  it("shows added and removed passages whole", () => {
    expect(wordDiff("", "새 줄")).toEqual([{ kind: "ins", text: "새 줄" }]);
    expect(wordDiff("지울 줄", "")).toEqual([{ kind: "del", text: "지울 줄" }]);
    expect(wordDiff("같아", "같아")).toEqual([{ kind: "same", text: "같아" }]);
  });

  it("shortens long unchanged runs around the change", () => {
    const long = "가".repeat(200);
    const compact = compactDiff(wordDiff(`${long} 끝`, `${long} 시작`), 10);
    expect(compact[0]).toEqual({ kind: "same", text: `…${"가".repeat(9)} ` });
    expect(compact.slice(1)).toEqual([{ kind: "del", text: "끝" }, { kind: "ins", text: "시작" }]);
  });
});

describe("the Mac's proposals", () => {
  it("reads piece and picture proposals and drops what is not one", () => {
    const proposals = decodeProposals({
      proposals: [
        { id: "p1", kind: "piece", createdAt: 10, status: "open", label: "세뇨는 이런 애야 › 말투", piece: "soul", before: "a", after: "b" },
        { id: "p2", kind: "avatar", createdAt: 20, status: "applied", label: "새 프사", image: { url: "data:image/png;base64,AA" } },
        { id: "p3", kind: "piece", createdAt: 30, status: "open", label: "x" },
        { id: "p4", kind: "avatar", createdAt: 40, status: "open", label: "x", image: null },
        { kind: "piece", createdAt: 50, before: "a", after: "b" },
        { id: "p6", kind: "piece", createdAt: "2026-11-21T00:00:00Z", status: "weird", label: "y", before: "", after: "c" },
      ],
    });
    expect(proposals.map((item) => [item.id, item.kind, item.status])).toEqual([
      ["p1", "piece", "open"],
      ["p2", "avatar", "applied"],
    ]);
    expect(decodeProposals(null)).toEqual([]);
  });

  it("keeps a stale one, reads a time as ISO, and drops a status it does not know", () => {
    const proposals = decodeProposals({
      proposals: [
        { id: "s", kind: "piece", createdAt: "2026-11-21T00:00:00Z", status: "stale", label: "말투", before: "a", after: "b" },
        { id: "n", kind: "piece", createdAt: 5, label: "말투", before: "a", after: "b" },
        { id: "w", kind: "piece", createdAt: 6, status: "weird", label: "말투", before: "a", after: "b" },
      ],
    });
    expect(proposals.map((item) => [item.id, item.status, item.createdAt])).toEqual([
      ["s", "stale", Date.parse("2026-11-21T00:00:00Z")],
      ["n", "open", 5],
    ]);
  });
});
