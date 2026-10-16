import { describe, expect, it } from "vite-plus/test";

import { parseMarkdownFileLink } from "./markdownLinks.ts";

// Rubato: file links whose names are not ASCII (file-link-edits.mjs).
describe("parseMarkdownFileLink with non-ASCII names", () => {
  it.each([
    ["output/제출용/01_답변서.pdf", "output/제출용/01_답변서.pdf"],
    ["output/내부/제출확인목록.md", "output/내부/제출확인목록.md"],
    // A folder: the file surface shows it in the explorer tree.
    ["output/제출용", "output/제출용"],
    ["답변서.pdf", "답변서.pdf"],
    ["docs/회의 메모.md", "docs/회의 메모.md"],
    ["notes/café.md", "notes/café.md"],
    // Rendered links arrive percent-encoded.
    [
      "output/%EC%A0%9C%EC%B6%9C%EC%9A%A9/01_%EB%8B%B5%EB%B3%80%EC%84%9C.pdf",
      "output/제출용/01_답변서.pdf",
    ],
  ])("reads %s as a file", (href, path) => {
    expect(parseMarkdownFileLink(href)?.path).toBe(path);
  });

  it("keeps the line suffix", () => {
    expect(parseMarkdownFileLink("문서/설계.md:12")).toEqual({ path: "문서/설계.md", line: 12 });
  });

  it.each(["설명", "설명 문장", "https://예시.com/경로"])(
    "does not read %s as a file",
    (href) => {
      expect(parseMarkdownFileLink(href)).toBeNull();
    },
  );
});
