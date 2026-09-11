import { Text, truncateToWidth } from "../host-sdk.mjs";
const URL_BUDGET = 92;
const PREVIEW_LINES = 4;
const PREVIEW_WIDTH = 120;
export function renderWebfetchCall(args, theme) {
    const webfetchArgs = parseWebfetchArgs(args);
    const head = theme.fg("toolTitle", theme.bold("webfetch "));
    const url = theme.fg("accent", shorten(webfetchArgs.url, URL_BUDGET));
    const format = theme.fg("muted", ` [${webfetchArgs.format ?? "markdown"}]`);
    const timeout = webfetchArgs.timeout === undefined ? "" : theme.fg("dim", ` ${webfetchArgs.timeout}s`);
    return new Text(head + url + format + timeout, 0, 0);
}
export function renderWebfetchResult(result, options, theme) {
    if (options.isPartial) {
        const details = result.details;
        if (isWebfetchProgressDetails(details)) {
            return new Text(theme.fg("warning", formatProgress(details)), 0, 0);
        }
        return new Text(theme.fg("warning", "Fetching..."), 0, 0);
    }
    const details = result.details;
    const text = result.content.find((block) => block.type === "text")?.text ?? "";
    if (!isWebfetchDetails(details)) {
        return new Text(theme.fg("muted", truncateToWidth(text, PREVIEW_WIDTH)), 0, 0);
    }
    const statusKey = details.status >= 200 && details.status < 300 ? "success" : "warning";
    const status = theme.fg(statusKey, `${details.status} ${details.statusText || "OK"}`);
    const format = theme.fg("accent", details.format);
    const size = theme.fg("muted", formatBytes(details.bytes));
    const converted = details.converted ? theme.fg("dim", " converted") : "";
    const truncatedNote = details.outputTruncated ? theme.fg("warning", " truncated") : "";
    const header = `${status} ${theme.fg("muted", "•")} ${format} ${theme.fg("muted", "•")} ${size}${converted}${truncatedNote}`;
    if (!options.expanded) {
        const preview = previewText(text, theme);
        return new Text([header, ...preview].join("\n"), 0, 0);
    }
    const lines = [
        header,
        theme.fg("dim", `URL: ${shorten(details.finalUrl, URL_BUDGET)}`),
        theme.fg("dim", `Content-Type: ${details.contentType || "unknown"}`),
        "",
        ...collectLines(text, 24).map((line) => theme.fg("toolOutput", truncateToWidth(line, PREVIEW_WIDTH))),
    ];
    return new Text(lines.join("\n"), 0, 0);
}
function collectLines(text, limit) {
    const lines = [];
    let start = 0;
    while (lines.length < limit && start <= text.length) {
        const newlineIndex = text.indexOf("\n", start);
        if (newlineIndex === -1) {
            lines.push(text.slice(start));
            break;
        }
        lines.push(text.slice(start, newlineIndex));
        start = newlineIndex + 1;
    }
    return lines;
}
function collectNonEmptyTrimmedLines(text, limit) {
    const lines = [];
    let start = 0;
    while (lines.length < limit && start <= text.length) {
        const newlineIndex = text.indexOf("\n", start);
        const line = (newlineIndex === -1 ? text.slice(start) : text.slice(start, newlineIndex)).trim();
        if (line.length > 0)
            lines.push(line);
        if (newlineIndex === -1)
            break;
        start = newlineIndex + 1;
    }
    return lines;
}
function parseWebfetchArgs(args) {
    if (typeof args !== "object" || args === null) {
        return { url: "" };
    }
    const webfetchArgs = {
        url: "url" in args && typeof args.url === "string" ? args.url : "",
    };
    if ("format" in args && typeof args.format === "string")
        webfetchArgs.format = args.format;
    if ("timeout" in args && typeof args.timeout === "number")
        webfetchArgs.timeout = args.timeout;
    return webfetchArgs;
}
function formatProgress(details) {
    const url = shorten(details.url, URL_BUDGET);
    if (details.phase === "downloading") {
        const downloaded = formatBytes(details.bytesRead ?? 0);
        const total = details.totalBytes === undefined ? "" : ` / ${formatBytes(details.totalBytes)}`;
        return `Downloading ${url}: ${downloaded}${total}`;
    }
    if (details.phase === "converting") {
        return `Converting ${url} to ${details.format}`;
    }
    return `Fetching ${url} as ${details.format} (${details.timeoutSeconds}s)`;
}
function isWebfetchProgressDetails(details) {
    return (typeof details === "object" &&
        details !== null &&
        "phase" in details &&
        (details.phase === "fetching" || details.phase === "downloading" || details.phase === "converting"));
}
function isWebfetchDetails(details) {
    return typeof details === "object" && details !== null && "status" in details && typeof details.status === "number";
}
function previewText(text, theme) {
    const lines = collectNonEmptyTrimmedLines(text, PREVIEW_LINES);
    if (lines.length === 0)
        return [theme.fg("dim", "  empty response")];
    return lines.map((line) => theme.fg("toolOutput", `  ${truncateToWidth(line, PREVIEW_WIDTH)}`));
}
function shorten(value, max) {
    if (value.length <= max)
        return value;
    return `${value.slice(0, max - 1)}…`;
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
//# sourceMappingURL=renderers.js.map
