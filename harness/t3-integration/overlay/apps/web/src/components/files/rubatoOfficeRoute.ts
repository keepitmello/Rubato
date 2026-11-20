import type { OfficePreviewKind } from "@t3tools/shared/filePreview";

/**
 * Rubato adds these to upstream's office table (filePreview.ts). Hangul documents are
 * read by HwpViewer; a macro-enabled workbook is an xlsx package, so it goes to the
 * Open XML viewer as one. Neither ever reaches the extended document worker.
 */
export type RubatoOfficePreviewKind = Extract<OfficePreviewKind, "hwp" | "hwpx" | "xlsm">;
export type HwpPreviewKind = Extract<OfficePreviewKind, "hwp" | "hwpx">;

export type OfficeViewerRoute =
  | { readonly viewer: "hwp"; readonly kind: HwpPreviewKind }
  | { readonly viewer: "open-xml"; readonly kind: "docx" | "xlsx" | "pptx" }
  | {
      readonly viewer: "extended";
      readonly kind: Exclude<OfficePreviewKind, RubatoOfficePreviewKind | "docx" | "xlsx" | "pptx">;
    };

export function officeViewerRoute(kind: OfficePreviewKind): OfficeViewerRoute {
  if (kind === "hwp" || kind === "hwpx") return { viewer: "hwp", kind };
  // The preview reads cells and drawings only; it never runs the workbook's macros.
  if (kind === "xlsm") return { viewer: "open-xml", kind: "xlsx" };
  if (kind === "docx" || kind === "xlsx" || kind === "pptx") return { viewer: "open-xml", kind };
  return { viewer: "extended", kind };
}
