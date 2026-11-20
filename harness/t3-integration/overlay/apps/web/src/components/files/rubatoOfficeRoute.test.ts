import { officePreviewKind } from "@t3tools/shared/filePreview";
import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";

import { prepareOffice } from "./officeArchive";
import { officeViewerRoute } from "./rubatoOfficeRoute";

const route = (name: string) => {
  const kind = officePreviewKind({ name });
  if (kind === null) throw new Error(`${name} is not an office document`);
  return officeViewerRoute(kind);
};

const SHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A macro-enabled workbook as Excel saves it: its own main content type and a VBA part. */
async function macroWorkbook() {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<workbook xmlns="${SHEET}" xmlns:r="${DOC_REL}"><sheets><sheet name="매출" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${DOC_REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>`,
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<worksheet xmlns="${SHEET}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>품목</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>`,
  );
  zip.file("xl/vbaProject.bin", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]));
  return zip.generateAsync({ type: "arraybuffer" });
}

describe("which office viewer opens a file", () => {
  it("sends Hangul documents to the HWP viewer", () => {
    expect(route("공문.hwp")).toEqual({ viewer: "hwp", kind: "hwp" });
    expect(route("docs/공문.HWPX")).toEqual({ viewer: "hwp", kind: "hwpx" });
  });

  it("sends Word, Excel and PowerPoint to upstream's Open XML viewer", () => {
    expect(route("보고서.docx")).toEqual({ viewer: "open-xml", kind: "docx" });
    expect(route("plan.xlsx")).toEqual({ viewer: "open-xml", kind: "xlsx" });
    expect(route("deck.pptx")).toEqual({ viewer: "open-xml", kind: "pptx" });
  });

  it("reads a macro-enabled workbook as xlsx in the Open XML viewer", () => {
    expect(route("macro.xlsm")).toEqual({ viewer: "open-xml", kind: "xlsx" });
  });

  it("leaves OpenDocument, RTF, EPUB and notebooks to upstream's extended viewer", () => {
    for (const [name, kind] of [
      ["memo.odt", "odt"],
      ["sheet.ods", "ods"],
      ["slides.odp", "odp"],
      ["letter.rtf", "rtf"],
      ["book.epub", "epub"],
      ["analysis.ipynb", "ipynb"],
    ] as const) {
      expect(route(name)).toEqual({ viewer: "extended", kind });
    }
  });

  it("prepares a macro-enabled workbook the way upstream prepares an xlsx", async () => {
    const prepared = await prepareOffice(await macroWorkbook(), "xlsx");
    expect(prepared.truncated).toBe(false);
    expect(prepared.view?.hiddenGridlines).toEqual([]);
    const archive = await JSZip.loadAsync(prepared.bytes);
    expect(await archive.file("xl/worksheets/sheet1.xml")?.async("string")).toContain("품목");
  });
});
