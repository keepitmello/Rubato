import { describe, expect, it } from "vite-plus/test";

import {
  filePreviewKind,
  hostPreviewMimeTypeFromExtension,
  isWorkspacePreviewEntryPath,
  officePreviewKind,
} from "./filePreview.ts";

describe("Rubato office kinds in upstream's office table", () => {
  it("classifies Hangul documents and macro-enabled workbooks by literal extension", () => {
    expect(officePreviewKind({ name: "공문.hwp" })).toBe("hwp");
    expect(officePreviewKind({ name: "docs/공문.HWPX" })).toBe("hwpx");
    expect(officePreviewKind({ name: "macro.xlsm" })).toBe("xlsm");
    expect(officePreviewKind({ name: "공문.hwp", mimeType: "application/octet-stream" })).toBe(
      "hwp",
    );
    expect(officePreviewKind({ name: "download", mimeType: "application/x-hwp" })).toBe("hwp");
    expect(officePreviewKind({ name: "download", mimeType: "application/hwp+zip" })).toBe("hwpx");
    expect(filePreviewKind({ name: "공문.hwpx" })).toBe("hwpx");
    expect(officePreviewKind({ name: "legacy.hwt" })).toBeNull();
    expect(officePreviewKind({ name: "공문.hwp.txt" })).toBeNull();
  });

  it("leaves Word, Excel and PowerPoint to upstream's own kinds", () => {
    expect(officePreviewKind({ name: "docs/보고서.docx" })).toBe("docx");
    expect(officePreviewKind({ name: "plan.xlsx" })).toBe("xlsx");
    expect(officePreviewKind({ name: "deck.pptx" })).toBe("pptx");
  });

  it("lets the asset server issue and type them", () => {
    for (const name of ["공문.hwp", "공문.hwpx", "macro.xlsm"]) {
      expect(isWorkspacePreviewEntryPath(name)).toBe(true);
    }
    expect(hostPreviewMimeTypeFromExtension(".hwp")).toBe("application/x-hwp");
    expect(hostPreviewMimeTypeFromExtension(".HWPX")).toBe("application/hwp+zip");
    expect(hostPreviewMimeTypeFromExtension(".xlsm")).toBe(
      "application/vnd.ms-excel.sheet.macroEnabled.12",
    );
  });
});
