import { basename } from "node:path";
import { Text, truncateToWidth } from "../host-sdk.mjs";
const GOAL_PREVIEW_WIDTH = 110;
const RESULT_PREVIEW_LINES = 4;
const RESULT_PREVIEW_WIDTH = 120;
const IMAGE_ATTACHMENT_REFERENCE = /^\s*(?:\[?Image #([1-9]\d*)(?:,[^\]\n]*)?\]?|(?:attachment|image):\/\/([1-9]\d*))\s*$/i;
export function renderLookAtCall(args, theme, _context) {
    const sources = sourceLabels(args);
    const sourceSummary = sources.length > 0 ? sources.join(", ") : "no sources";
    const goal = oneLine(args.goal) || "pending";
    const title = theme.fg("toolTitle", theme.bold("look_at "));
    return new Text([
        title + theme.fg("accent", sourceSummary),
        theme.fg("muted", "goal: ") + theme.fg("toolOutput", shorten(goal, GOAL_PREVIEW_WIDTH)),
    ].join("\n"), 0, 0);
}
export function renderLookAtResult(result, options, theme, _context) {
    const model = typeof result.details?.model === "string" ? result.details.model.trim() : "";
    const text = textContent(result);
    const rows = [];
    if (model) {
        rows.push(theme.fg("accent", `[vision ${model}]`));
    }
    if (!text) {
        rows.push(theme.fg(options.isPartial ? "warning" : "dim", options.isPartial ? "Analyzing media..." : "empty response"));
    }
    else if (options.expanded) {
        rows.push(...text.split("\n").map((line) => theme.fg("toolOutput", line)));
    }
    else {
        rows.push(...previewLines(text, theme));
    }
    return new Text(rows.join("\n"), 0, 0);
}
function sourceLabels(args) {
    const paths = [...stringValues(args.file_paths), ...stringValue(args.file_path)];
    const base64Inputs = [...stringValues(args.image_data_list), ...stringValue(args.image_data)];
    return [...paths.map(pathLabel), ...base64Inputs.map(() => "base64 input")];
}
function stringValues(value) {
    return value?.filter((item) => item.trim().length > 0) ?? [];
}
function stringValue(value) {
    return value?.trim() ? [value] : [];
}
function pathLabel(path) {
    const match = IMAGE_ATTACHMENT_REFERENCE.exec(path);
    const imageIndex = match?.[1] ?? match?.[2];
    return imageIndex ? `Image #${imageIndex}` : basename(path);
}
function textContent(result) {
    return result.content.find((block) => block.type === "text")?.text ?? "";
}
function previewLines(text, theme) {
    const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, RESULT_PREVIEW_LINES);
    if (lines.length === 0)
        return [theme.fg("dim", "empty response")];
    return lines.map((line) => theme.fg("toolOutput", `  ${truncateToWidth(line, RESULT_PREVIEW_WIDTH)}`));
}
function oneLine(value) {
    return value?.replace(/\s+/g, " ").trim() ?? "";
}
function shorten(value, max) {
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
//# sourceMappingURL=render.js.map
