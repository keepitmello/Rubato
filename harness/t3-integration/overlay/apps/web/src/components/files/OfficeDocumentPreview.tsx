/* oxlint-disable react/no-array-index-key -- Sheet rows and columns have stable positions and may contain identical values. */
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import type { OfficePreviewKind } from "@t3tools/shared/filePreview";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { useOpenLink } from "~/browser/useOpenLink";
import { cn } from "~/lib/utils";

import { FileSurfaceFailure, FileSurfaceLoading, FileSurfaceNotice } from "./fileSurfaceChrome";
import { readXlsxWorkbook, XLSX_PREVIEW_MAX_COLUMNS, XLSX_PREVIEW_MAX_ROWS, type XlsxSheet } from "./rubatoXlsx";

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly bytes: ArrayBuffer };

/**
 * Reads Word, Excel, PowerPoint and Hangul documents in the file surface. The file
 * comes from the same signed asset URL the image and PDF viewers use and is turned
 * into a page in this client; nothing is uploaded or converted on the server.
 */
export function OfficeDocumentPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly name: string;
  readonly kind: OfficePreviewKind;
  readonly workspaceMutationId: string | null;
}) {
  const insideWorkspace =
    mediaFileReference(props.absolutePath, props.workspaceRoot).relativePath !== undefined;
  const resource = useMemo(
    () => ({
      _tag: insideWorkspace ? ("workspace-file" as const) : ("media-file" as const),
      threadId: props.threadRef.threadId,
      path: props.absolutePath,
    }),
    [insideWorkspace, props.threadRef.threadId, props.absolutePath],
  );
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const url = assetUrl._tag === "Success" ? assetUrl.url : null;

  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    setLoaded({ status: "loading" });
    void (async () => {
      const response = await fetch(url, {
        signal: controller.signal,
        // A workspace change or a retry must read the file again, not the cached copy.
        cache: props.workspaceMutationId === null && attempt === 0 ? "default" : "reload",
      });
      if (!response.ok) throw new Error(`The file could not be loaded (${response.status}).`);
      const bytes = await response.arrayBuffer();
      if (!controller.signal.aborted) setLoaded({ status: "ready", bytes });
    })().catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setLoaded({ status: "failed", message: cause instanceof Error ? cause.message : "The file could not be loaded." });
    });
    return () => controller.abort();
  }, [url, props.workspaceMutationId, attempt]);

  const retry = () => {
    setAttempt((current) => current + 1);
    // The signed URL lasts an hour; a retry after that needs a fresh one.
    void refreshAssetUrl().catch(() => undefined);
  };

  if (assetUrl._tag === "Failure") return <FileSurfaceFailure message="Unable to load file preview." onRetry={retry} />;
  if (loaded.status === "failed") return <FileSurfaceFailure message={loaded.message} onRetry={retry} />;
  if (url === null || loaded.status === "loading") return <FileSurfaceLoading />;
  return props.kind === "xlsx" ? (
    <WorkbookPreview key={url} name={props.name} bytes={loaded.bytes} />
  ) : (
    <DocumentFrame
      key={url}
      name={props.name}
      kind={props.kind}
      bytes={loaded.bytes}
      threadRef={props.threadRef}
    />
  );
}

// The frame runs no scripts (sandbox without allow-scripts), so markup inside a
// document cannot act on the app; same-origin lets this component fill it.
const FRAME_SHELL = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#e5e5e5;color:#111}
html,body{width:max-content;min-width:100%}
.rubato-pages{display:flex;flex-direction:column;align-items:center;gap:16px;padding:16px}
.rubato-page{background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);flex:none}
.rubato-page>svg{display:block}
.docx-wrapper{background:transparent!important;padding:0!important}
</style></head><body></body></html>`;

type HwpModule = typeof import("@rhwp/core");
let hwpModule: Promise<HwpModule> | null = null;

function loadHwp(): Promise<HwpModule> {
  hwpModule ??= (async () => {
    const [module, wasm] = await Promise.all([import("@rhwp/core"), import("@rhwp/core/rhwp_bg.wasm?url")]);
    // The layout engine measures text through the host's canvas; register before init.
    let context: CanvasRenderingContext2D | null = null;
    let lastFont = "";
    (globalThis as { measureTextWidth?: (font: string, text: string) => number }).measureTextWidth = (font, text) => {
      context ??= document.createElement("canvas").getContext("2d");
      if (!context) return 0;
      if (font !== lastFont) {
        context.font = font;
        lastFont = font;
      }
      return context.measureText(text).width;
    };
    await module.default({ module_or_path: wasm.default });
    return module;
  })().catch((cause: unknown) => {
    hwpModule = null;
    throw cause;
  });
  return hwpModule;
}

const yieldToFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function renderInto(kind: Exclude<OfficePreviewKind, "xlsx">, bytes: ArrayBuffer, doc: Document, isCancelled: () => boolean) {
  const pages = doc.createElement("div");
  pages.className = "rubato-pages";
  doc.body.replaceChildren(pages);
  if (kind === "docx") {
    const { renderAsync } = await import("docx-preview");
    // docx-preview empties its style container first; keep it off the frame's own <head>.
    const styles = doc.createElement("div");
    styles.hidden = true;
    doc.body.prepend(styles);
    await renderAsync(bytes, pages, styles, {
      inWrapper: true,
      ignoreLastRenderedPageBreak: true,
      useBase64URL: true,
      renderChanges: false,
      renderComments: false,
    });
    return;
  }
  if (kind === "pptx") {
    const { pptxToHtml } = await import("@jvmr/pptx-to-html");
    const slides = await pptxToHtml(bytes);
    if (isCancelled()) return;
    for (const slide of slides) {
      const page = doc.createElement("section");
      page.className = "rubato-page";
      page.innerHTML = slide;
      pages.append(page);
    }
    if (slides.length === 0) pages.textContent = "This presentation has no slides.";
    return;
  }
  const { HwpDocument } = await loadHwp();
  const hwp = new HwpDocument(new Uint8Array(bytes));
  try {
    const count = hwp.pageCount();
    for (let index = 0; index < count; index += 1) {
      if (isCancelled()) return;
      const page = doc.createElement("section");
      page.className = "rubato-page";
      page.innerHTML = hwp.renderPageSvg(index);
      pages.append(page);
      // Long documents paint page by page instead of freezing the panel.
      if (index % 4 === 3) await yieldToFrame();
    }
  } finally {
    hwp.free();
  }
}

function DocumentFrame(props: {
  readonly name: string;
  readonly kind: Exclude<OfficePreviewKind, "xlsx">;
  readonly bytes: ArrayBuffer;
  readonly threadRef: ScopedThreadRef;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const openLink = useOpenLink(props.threadRef);
  const openLinkRef = useRef(openLink);
  openLinkRef.current = openLink;

  // Pages keep their real size; the whole page column scales down to the panel width.
  const fit = useCallback(() => {
    const frame = frameRef.current;
    const body = frame?.contentDocument?.body;
    if (!frame || !body) return;
    body.style.zoom = "1";
    // The page column is as wide as its widest page (max-content), so pages wider
    // than the panel overflow to the right where they can be measured, not the left.
    const natural = body.getBoundingClientRect().width;
    const available = frame.clientWidth;
    body.style.zoom = natural > available && natural > 0 ? String(available / natural) : "1";
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frameReady || !frame) return;
    const observer = new ResizeObserver(fit);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frameReady, fit]);

  useEffect(() => {
    const doc = frameRef.current?.contentDocument;
    if (!frameReady || !doc) return;
    let cancelled = false;
    setRendering(true);
    setError(null);
    // Links go where the app sends links, never navigate the preview frame.
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#")) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(href)) void openLinkRef.current(href, { event }).catch(() => undefined);
    };
    doc.addEventListener("click", onClick);
    void renderInto(props.kind, props.bytes, doc, () => cancelled)
      .then(() => {
        if (cancelled) return;
        setRendering(false);
        fit();
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        console.error(cause);
        setRendering(false);
        setError(cause instanceof Error && cause.message ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
      doc.removeEventListener("click", onClick);
    };
  }, [frameReady, props.kind, props.bytes, fit]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {error ? (
        <FileSurfaceFailure message={`This document could not be displayed: ${error}`} />
      ) : null}
      <iframe
        ref={frameRef}
        title={props.name}
        srcDoc={FRAME_SHELL}
        sandbox="allow-same-origin"
        onLoad={() => setFrameReady(true)}
        className={cn("min-h-0 flex-1 border-0", error && "hidden")}
      />
      {rendering && !error ? <FileSurfaceLoading className="absolute inset-0 bg-background/60" /> : null}
    </div>
  );
}

function WorkbookPreview(props: { readonly name: string; readonly bytes: ArrayBuffer }) {
  const [sheets, setSheets] = useState<XlsxSheet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    let cancelled = false;
    readXlsxWorkbook(props.bytes)
      .then((result) => !cancelled && setSheets(result))
      .catch((cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      cancelled = true;
    };
  }, [props.bytes]);
  if (error) return <FileSurfaceFailure message={`This workbook could not be displayed: ${error}`} />;
  if (sheets === null) return <FileSurfaceLoading />;
  if (sheets.length === 0) return <FileSurfaceFailure message="This workbook has no sheets." />;
  const sheet = sheets[Math.min(selected, sheets.length - 1)]!;
  const [header, ...body] = sheet.rows;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sheet.truncated ? (
        <FileSurfaceNotice>
          Sheet limited to the first {XLSX_PREVIEW_MAX_ROWS.toLocaleString()} rows and {XLSX_PREVIEW_MAX_COLUMNS} columns.
        </FileSurfaceNotice>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {sheet.rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">This sheet is empty.</p>
        ) : (
          <table className="min-w-full border-separate border-spacing-0 text-xs" aria-label={`${props.name} — ${sheet.name}`}>
            {header ? (
              <thead className="sticky top-0 z-10">
                <tr>
                  {header.map((cell, columnIndex) => (
                    <th
                      key={columnIndex}
                      scope="col"
                      className="max-w-80 border-b border-border bg-muted/60 px-3 py-1.5 text-left align-bottom font-medium whitespace-pre-wrap break-words backdrop-blur"
                    >
                      {cell}
                    </th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {body.map((row, rowIndex) => (
                <tr key={rowIndex} className="even:bg-muted/30">
                  {row.map((cell, columnIndex) => (
                    <td
                      key={columnIndex}
                      className="max-w-80 border-b border-border/60 px-3 py-1.5 align-top whitespace-pre-wrap break-words tabular-nums"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {sheets.length > 1 ? (
        <div role="tablist" aria-label="Sheets" className="flex shrink-0 gap-0.5 overflow-x-auto border-t border-border/60 px-2 py-1">
          {sheets.map((entry, index) => (
            <button
              key={index}
              type="button"
              role="tab"
              aria-selected={index === selected}
              onClick={() => setSelected(index)}
              className={cn(
                "shrink-0 rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                index === selected && "bg-accent text-foreground",
              )}
            >
              {entry.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
