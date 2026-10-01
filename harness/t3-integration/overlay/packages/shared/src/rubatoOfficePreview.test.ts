import { describe, expect, it } from "vite-plus/test";

import {
  hostPreviewMimeTypeFromExtension,
  isWorkspacePreviewEntryPath,
  officePreviewKind,
} from "./filePreview.ts";

describe("office document previews", () => {
  it("classifies Word, Excel, PowerPoint and Hangul files by literal extension", () => {
    expect(officePreviewKind("docs/보고서.DOCX")).toBe("docx");
    expect(officePreviewKind("plan.xlsx")).toBe("xlsx");
    expect(officePreviewKind("macro.xlsm")).toBe("xlsx");
    expect(officePreviewKind("deck.pptx")).toBe("pptx");
    expect(officePreviewKind("공문.hwp")).toBe("hwp");
    expect(officePreviewKind("공문.hwpx")).toBe("hwp");
    expect(officePreviewKind("legacy.doc")).toBeNull();
    expect(officePreviewKind("report.docx.txt")).toBeNull();
    expect(officePreviewKind("README")).toBeNull();
  });

  it("lets the asset server issue and serve them", () => {
    expect(isWorkspacePreviewEntryPath("deck.pptx")).toBe(true);
    expect(isWorkspacePreviewEntryPath("notes.txt")).toBe(false);
    expect(hostPreviewMimeTypeFromExtension(".hwp")).toBe("application/x-hwp");
    expect(hostPreviewMimeTypeFromExtension(".XLSX")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });
});
