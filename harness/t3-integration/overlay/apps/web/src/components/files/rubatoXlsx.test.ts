import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";

import { readXlsxWorkbook, XLSX_PREVIEW_MAX_ROWS } from "./rubatoXlsx";

async function workbook(sheets: Record<string, string>, sharedStrings?: string) {
  const zip = new JSZip();
  const names = Object.keys(sheets);
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names
      .map((name, index) => `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
      .join("")}</sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<Relationships>${names
      .map((_, index) => `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`)
      .join("")}</Relationships>`,
  );
  names.forEach((name, index) => zip.file(`xl/worksheets/sheet${index + 1}.xml`, `<worksheet><sheetData>${sheets[name]}</sheetData></worksheet>`));
  if (sharedStrings) zip.file("xl/sharedStrings.xml", `<sst>${sharedStrings}</sst>`);
  return zip.generateAsync({ type: "uint8array" });
}

describe("readXlsxWorkbook", () => {
  it("reads every sheet with shared, inline, boolean and numeric cells in position, numbers as Excel shows them", async () => {
    const data = await workbook(
      {
        "매출": '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="3"><c r="A3"><v>2.0019999999999998</v></c><c r="B3" t="b"><v>1</v></c><c r="C3" t="inlineStr"><is><t>a &amp; b</t></is></c></row>',
        Empty: "",
      },
      '<si><t>이름</t></si><si><r><t>합</t></r><r><t xml:space="preserve">계 </t></r><rPh><t>ごう</t></rPh></si>',
    );
    expect(await readXlsxWorkbook(data)).toEqual([
      { name: "매출", rows: [["이름", "", "합계 "], ["", "", ""], ["2.002", "TRUE", "a & b"]], truncated: false },
      { name: "Empty", rows: [], truncated: false },
    ]);
  });

  it("bounds very large sheets and says so", async () => {
    const wide = `<row r="1"><c r="A1"><v>1</v></c><c r="${"C".repeat(3)}1"><v>2</v></c></row>`;
    const tall = `<row r="${XLSX_PREVIEW_MAX_ROWS + 5}"><c r="A${XLSX_PREVIEW_MAX_ROWS + 5}"><v>3</v></c></row>`;
    const [sheet] = await readXlsxWorkbook(await workbook({ Big: wide + tall }));
    expect(sheet!.truncated).toBe(true);
    expect(sheet!.rows).toEqual([["1"]]);
  });

  it("rejects a zip that is not a workbook", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", "<w:document/>");
    await expect(readXlsxWorkbook(await zip.generateAsync({ type: "uint8array" }))).rejects.toThrow(
      "not an Excel workbook",
    );
  });
});
