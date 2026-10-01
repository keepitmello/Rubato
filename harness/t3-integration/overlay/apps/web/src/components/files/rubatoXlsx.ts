import JSZip from "jszip";

export interface XlsxSheet {
  readonly name: string;
  /** Row-major cell text; ragged rows are padded to the widest kept row. */
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  /** True when rows or columns past the preview bounds were dropped. */
  readonly truncated: boolean;
}

export const XLSX_PREVIEW_MAX_ROWS = 1000;
export const XLSX_PREVIEW_MAX_COLUMNS = 60;

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    if (entity[0] !== "#") return ENTITY[entity.toLowerCase()] ?? match;
    const code =
      entity[1] === "x" || entity[1] === "X"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  });
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return match ? decodeXml(match[2] ?? match[3] ?? "") : undefined;
}

/** Concatenates the text runs of a shared or inline string, skipping phonetic hints. */
function richText(xml: string): string {
  const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let text = "";
  for (const match of withoutPhonetic.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) {
    text += decodeXml(match[1] ?? "");
  }
  return text;
}

/** "AB12" -> zero-based column 27. */
function columnIndex(reference: string): number | null {
  const letters = /^([A-Z]+)/i.exec(reference)?.[1];
  if (!letters) return null;
  let index = 0;
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/**
 * Excel stores the binary double ("2.0019999999999998") and shows at most 15
 * significant digits ("2.002"); show what Excel shows.
 */
function displayNumber(raw: string): string {
  const number = Number(raw);
  return raw.trim() !== "" && Number.isFinite(number) ? String(Number(number.toPrecision(15))) : raw;
}

function resolveTarget(target: string): string {
  const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
}

function readSheet(xml: string, sharedStrings: ReadonlyArray<string>, name: string): XlsxSheet {
  const rows: string[][] = [];
  let truncated = false;
  let width = 0;
  let nextRow = 0;
  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const declared = Number(attribute(rowMatch[1] ?? "", "r"));
    const rowIndex = Number.isInteger(declared) && declared > 0 ? declared - 1 : nextRow;
    nextRow = rowIndex + 1;
    if (rowIndex >= XLSX_PREVIEW_MAX_ROWS) {
      truncated = true;
      break;
    }
    const cells: string[] = [];
    let nextColumn = 0;
    for (const cellMatch of (rowMatch[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = cellMatch[1] ?? "";
      const body = cellMatch[2] ?? "";
      const reference = attribute(tag, "r");
      const column = (reference ? columnIndex(reference) : null) ?? nextColumn;
      nextColumn = column + 1;
      if (column >= XLSX_PREVIEW_MAX_COLUMNS) {
        truncated = true;
        continue;
      }
      const type = attribute(tag, "t");
      const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text: string;
      if (type === "s") text = sharedStrings[Number(value)] ?? "";
      else if (type === "inlineStr") text = richText(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "");
      else if (type === "b") text = value === "1" ? "TRUE" : value === "0" ? "FALSE" : "";
      else if (value === undefined) text = "";
      else if (type === undefined || type === "n") text = displayNumber(decodeXml(value));
      else text = decodeXml(value);
      while (cells.length < column) cells.push("");
      cells[column] = text;
    }
    while (rows.length < rowIndex) rows.push([]);
    rows[rowIndex] = cells;
    width = Math.max(width, cells.length);
  }
  // Trailing styled-but-empty rows carry no content worth a table row.
  while (rows.length > 0 && rows.at(-1)!.every((cell) => cell === "")) rows.pop();
  return {
    name,
    rows: rows.map((row) => (row.length < width ? [...row, ...Array(width - row.length).fill("")] : row)),
    truncated,
  };
}

/**
 * Reads every worksheet of an .xlsx/.xlsm workbook as cell text. Values are shown as
 * stored: numbers keep their raw form (dates stay serial numbers) and formulas show
 * their cached result.
 */
export async function readXlsxWorkbook(data: ArrayBuffer | Uint8Array): Promise<XlsxSheet[]> {
  const zip = await JSZip.loadAsync(data);
  const read = (path: string) => zip.file(path)?.async("string") ?? Promise.resolve(null);
  const workbook = await read("xl/workbook.xml");
  if (workbook === null) throw new Error("This file is not an Excel workbook.");
  const relations = new Map<string, string>();
  for (const match of ((await read("xl/_rels/workbook.xml.rels")) ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attribute(match[0], "Id");
    const target = attribute(match[0], "Target");
    if (id && target) relations.set(id, resolveTarget(target));
  }
  const sharedStrings: string[] = [];
  for (const match of ((await read("xl/sharedStrings.xml")) ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) {
    sharedStrings.push(richText(match[1] ?? ""));
  }
  const sheets: XlsxSheet[] = [];
  for (const match of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const tag = match[0];
    const id = attribute(tag, "r:id") ?? attribute(tag, "id");
    const path = id ? relations.get(id) : undefined;
    const xml = path ? await read(path) : null;
    if (xml === null) continue;
    sheets.push(readSheet(xml, sharedStrings, attribute(tag, "name") ?? `Sheet ${sheets.length + 1}`));
  }
  return sheets;
}
