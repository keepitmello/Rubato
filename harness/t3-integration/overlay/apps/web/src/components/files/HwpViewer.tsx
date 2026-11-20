import type { HwpDocument } from "@rhwp/core";
import { msg, T, useGT } from "gt-react";
import { useEffect, useRef, useState } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { m } from "~/i18n/messages";
import { observeResize } from "~/lib/observeResize";

import { FILE_SURFACE_SUBHEADER_CLASS, FileSurfaceLoading } from "./fileSurfaceChrome";
import { OFFICE_PREVIEW_MAX_BYTES } from "./officePreviewProtocol";
import { previewErrorText } from "./previewFailureMessages";
import type { HwpPreviewKind } from "./rubatoOfficeRoute";

// Rubato: Hangul (.hwp, .hwpx) documents. Upstream's office viewers do not read them;
// @rhwp/core (Rust + WebAssembly) lays each page out as SVG, loaded only when one opens.

async function readHwpFile(src: string, signal: AbortSignal) {
  const response = await fetch(src, { signal });
  if (!response.ok)
    throw new Error(m(msg("The file could not be loaded. Close it and try again.")));
  if (Number(response.headers.get("content-length")) > OFFICE_PREVIEW_MAX_BYTES)
    throw new Error(m(msg("Preview limited to files under 50 MB.")));
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > OFFICE_PREVIEW_MAX_BYTES)
    throw new Error(m(msg("Preview limited to files under 50 MB.")));
  return bytes;
}

type HwpModule = typeof import("@rhwp/core");
let hwpModule: Promise<HwpModule> | null = null;

function loadHwp(): Promise<HwpModule> {
  hwpModule ??= (async () => {
    const [module, wasm] = await Promise.all([
      import("@rhwp/core"),
      import("@rhwp/core/rhwp_bg.wasm?url"),
    ]);
    // The layout engine measures text through the host's canvas; register before init.
    let context: CanvasRenderingContext2D | null = null;
    let lastFont = "";
    (globalThis as { measureTextWidth?: (font: string, text: string) => number }).measureTextWidth =
      (font, text) => {
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

// The frame runs no scripts (sandbox without allow-scripts), so markup inside a
// document cannot act on the app; same-origin lets this component fill it.
const FRAME_SHELL = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#e5e5e5;color:#111}
html,body{width:max-content;min-width:100%}
.pages{display:flex;flex-direction:column;align-items:center;gap:16px;padding:16px}
.page{background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);flex:none}
.page>svg{display:block}
</style></head><body></body></html>`;

const yieldToFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function renderPages(
  bytes: ArrayBuffer,
  doc: Document,
  isCancelled: () => boolean,
  onCount: (count: number) => void,
) {
  const pages = doc.createElement("div");
  pages.className = "pages";
  doc.body.replaceChildren(pages);
  const { HwpDocument } = await loadHwp();
  const hwp: HwpDocument = new HwpDocument(new Uint8Array(bytes));
  try {
    const count = hwp.pageCount();
    onCount(count);
    for (let index = 0; index < count; index += 1) {
      if (isCancelled()) return;
      const page = doc.createElement("section");
      page.className = "page";
      page.innerHTML = hwp.renderPageSvg(index);
      pages.append(page);
      // Long documents paint page by page instead of freezing the panel.
      if (index % 4 === 3) await yieldToFrame();
    }
  } finally {
    hwp.free();
  }
}

export default function HwpViewer(props: {
  readonly src: string;
  readonly name: string;
  readonly kind: HwpPreviewKind;
  readonly sizeBytes?: number;
}) {
  const gt = useGT();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [rendering, setRendering] = useState(true);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fail = useStableCallback((cause: unknown) =>
    setError(previewErrorText(cause, m(msg("Could not read this file.")))),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the document fetch for this source and abort it on cleanup.
  useEffect(() => {
    if ((props.sizeBytes ?? 0) > OFFICE_PREVIEW_MAX_BYTES) {
      // oxlint-disable-next-line react/set-state-in-effect -- The file metadata can reject the preview before loading bytes or the engine.
      setError(m(msg("Preview limited to files under 50 MB.")));
      return;
    }
    const controller = new AbortController();
    void readHwpFile(props.src, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setBytes(loaded);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) fail(cause);
      });
    return () => controller.abort();
  }, [props.src, props.sizeBytes, fail]);

  // Pages keep their real size; the whole page column scales down to the panel width.
  const fit = useStableCallback(() => {
    const frame = frameRef.current;
    const body = frame?.contentDocument?.body;
    if (!frame || !body) return;
    body.style.zoom = "1";
    // The page column is as wide as its widest page (max-content), so pages wider
    // than the panel overflow to the right where they can be measured, not the left.
    const natural = body.getBoundingClientRect().width;
    const available = frame.clientWidth;
    body.style.zoom = natural > available && natural > 0 ? String(available / natural) : "1";
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refit the pages when the panel resizes and stop observing on cleanup.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frameReady || !frame) return;
    return observeResize(frame, fit);
  }, [frameReady, fit]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Paint the loaded document into the frame and stop painting on cleanup.
  useEffect(() => {
    const doc = frameRef.current?.contentDocument;
    if (!frameReady || !doc || bytes === null) return;
    let cancelled = false;
    setRendering(true);
    // Links never navigate the preview frame.
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (anchor && !(anchor.getAttribute("href") ?? "").startsWith("#")) event.preventDefault();
    };
    doc.addEventListener("click", onClick);
    void renderPages(bytes, doc, () => cancelled, setPageCount)
      .then(() => {
        if (cancelled) return;
        setRendering(false);
        fit();
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        console.error(cause);
        setRendering(false);
        fail(cause);
      });
    return () => {
      cancelled = true;
      doc.removeEventListener("click", onClick);
    };
  }, [frameReady, bytes, fit, fail]);

  if (error)
    return (
      <div
        role="alert"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center"
      >
        <p className="text-sm font-medium">
          <T>No preview for this file</T>
        </p>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          {gt("{error} Save it or open it in another app.", { error })}
        </p>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {pageCount > 0 ? (
        <div className={FILE_SURFACE_SUBHEADER_CLASS}>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {gt("{count, plural, one {{count} page} other {{count} pages}}", { count: pageCount })}
            {` · ${gt("Fit to width")}`}
          </span>
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <iframe
          ref={frameRef}
          title={props.name}
          srcDoc={FRAME_SHELL}
          sandbox="allow-same-origin"
          onLoad={() => setFrameReady(true)}
          className="min-h-0 flex-1 border-0"
        />
        {rendering ? <FileSurfaceLoading className="absolute inset-0 bg-background/60" /> : null}
      </div>
    </div>
  );
}
