import DOMPurify from "dompurify";
import { useRef } from "react";

/**
 * A ```svg fence drawn as the picture it describes (svg-figure-edits.mjs): the reply's own diagram,
 * in the chat's text colour and font, as wide as it was drawn and never wider than the chat, with
 * the fence title as its caption.
 *
 * The markup is the model's, so it goes through DOMPurify's SVG profile with everything that could
 * run, navigate or fetch taken out: no script, no <a>, no <image>, no <foreignObject>, no <style>
 * (an inline <style> would restyle the whole page), no href that leaves the document, no url()
 * that is not a local reference. Ids get a prefix so two figures in one chat never share a gradient.
 */
export type RubatoSvgFigureMarkup = {
  readonly markup: string;
  readonly width: number;
  readonly height: number;
};

const SVG_NS = "http://www.w3.org/2000/svg";
const LOCAL_REFERENCE = /^\s*#/;
const URL_FUNCTION = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
const CACHE_LIMIT = 64;
const cache = new Map<string, RubatoSvgFigureMarkup | null>();

let purifier: ReturnType<typeof DOMPurify> | null = null;

function svgPurifier() {
  if (purifier) return purifier;
  purifier = DOMPurify(window);
  purifier.addHook("uponSanitizeAttribute", (_node, data) => {
    const name = data.attrName.toLowerCase();
    if ((name === "href" || name === "xlink:href") && !LOCAL_REFERENCE.test(data.attrValue)) {
      data.keepAttr = false;
      return;
    }
    for (const [, , target] of data.attrValue.matchAll(URL_FUNCTION)) {
      if (!LOCAL_REFERENCE.test(target ?? "")) {
        data.keepAttr = false;
        return;
      }
    }
  });
  return purifier;
}

function sanitize(source: string): DocumentFragment {
  return svgPurifier().sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["a", "image", "foreignObject", "style", "script", "iframe"],
    RETURN_DOM_FRAGMENT: true,
  });
}

function dimension(value: string | null): number {
  if (value === null || !/^\s*\d+(?:\.\d+)?(?:px)?\s*$/.test(value)) return Number.NaN;
  return Number.parseFloat(value);
}

function viewBoxSize(svg: SVGSVGElement): { width: number; height: number } | null {
  const box = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (box.length !== 4 || !box.every(Number.isFinite) || box[2]! <= 0 || box[3]! <= 0) return null;
  return { width: box[2]!, height: box[3]! };
}

function hash(text: string): string {
  let value = 5381;
  for (let index = 0; index < text.length; index += 1) value = (value * 33) ^ text.charCodeAt(index);
  return (value >>> 0).toString(36);
}

/** Every id gets `prefix-`, and each `#id` reference in an attribute follows it. */
function prefixIds(svg: SVGSVGElement, prefix: string) {
  const renamed = new Map<string, string>();
  for (const element of [svg, ...svg.querySelectorAll("[id]")]) {
    const id = element.getAttribute("id");
    if (!id) continue;
    renamed.set(id, `${prefix}-${id}`);
    element.setAttribute("id", `${prefix}-${id}`);
  }
  if (renamed.size === 0) return;
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      const value = attribute.value;
      const next = value
        .replace(URL_FUNCTION, (match, quote: string, target: string) => {
          const id = target.trim().slice(1);
          return target.trim().startsWith("#") && renamed.has(id)
            ? `url(${quote}#${renamed.get(id)}${quote})`
            : match;
        })
        .replace(/^\s*#(.+)$/, (match, id: string) =>
          (attribute.name === "href" || attribute.name === "xlink:href") && renamed.has(id)
            ? `#${renamed.get(id)}`
            : match,
        );
      if (next !== value) element.setAttribute(attribute.name, next);
    }
  }
}

/**
 * The safe markup of one fence, or null when it is not an SVG picture (the fence then stays code).
 * Its size is the one it was drawn at: width and height, or the viewBox when those are missing or relative.
 */
export function rubatoSvgFigureMarkup(source: string): RubatoSvgFigureMarkup | null {
  const key = source.trim();
  if (cache.has(key)) return cache.get(key)!;
  let result: RubatoSvgFigureMarkup | null = null;
  try {
    const fragment = sanitize(key);
    const roots = [...fragment.children];
    const svg = roots.length === 1 ? roots[0] : null;
    if (svg instanceof SVGSVGElement && svg.namespaceURI === SVG_NS) {
      const box = viewBoxSize(svg);
      let width = dimension(svg.getAttribute("width"));
      let height = dimension(svg.getAttribute("height"));
      if (!(width > 0 && height > 0)) {
        width = box?.width ?? Number.NaN;
        height = box?.height ?? Number.NaN;
      }
      if (width > 0 && height > 0) {
        if (!box) svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
        svg.setAttribute("width", String(width));
        svg.setAttribute("height", String(height));
        svg.removeAttribute("style");
        svg.setAttribute("role", "img");
        prefixIds(svg, `rubato-svg-${hash(key)}`);
        // Sanitized once more as a string: what the page parses is exactly what DOMPurify returned.
        const markup = svgPurifier().sanitize(svg.outerHTML, {
          USE_PROFILES: { svg: true, svgFilters: true },
          FORBID_TAGS: ["a", "image", "foreignObject", "style", "script", "iframe"],
        });
        if (markup.includes("<svg")) result = { markup, width, height };
      }
    }
  } catch {
    result = null;
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}

let expandedUrl: string | null = null;

/** The figure as a standalone image for the viewer: its colours resolved, on the chat's background. */
function expandedImageUrl(svg: SVGSVGElement): string {
  const element = svg.cloneNode(true) as SVGSVGElement;
  const style = getComputedStyle(svg);
  element.style.color = style.color;
  element.style.fontFamily = style.fontFamily;
  element.style.backgroundColor = getComputedStyle(document.body).backgroundColor;
  element.setAttribute("xmlns", SVG_NS);
  if (expandedUrl) URL.revokeObjectURL(expandedUrl);
  expandedUrl = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(element)], { type: "image/svg+xml" }),
  );
  return expandedUrl;
}

export function RubatoSvgFigure({
  figure,
  title,
  onExpand,
}: {
  /** Null while the fence is still streaming in. */
  figure: RubatoSvgFigureMarkup | null;
  title: string | null;
  onExpand: (imageUrl: string) => void;
}) {
  const picture = useRef<HTMLSpanElement>(null);
  return (
    <figure className="rubato-svg-figure my-3" data-rubato-svg-figure="">
      {figure ? (
        <span
          ref={picture}
          role="button"
          tabIndex={0}
          className="block w-fit max-w-full cursor-zoom-in"
          onClick={() => {
            const svg = picture.current?.querySelector("svg");
            if (svg) onExpand(expandedImageUrl(svg));
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            const svg = picture.current?.querySelector("svg");
            if (svg) onExpand(expandedImageUrl(svg));
          }}
          aria-label={title ?? undefined}
          // oxlint-disable-next-line react/no-danger -- DOMPurify's output for an SVG with nothing that runs, navigates or fetches
          dangerouslySetInnerHTML={{ __html: figure.markup }}
        />
      ) : (
        <span className="block h-24 w-full max-w-md animate-pulse rounded-lg bg-muted" aria-hidden />
      )}
      {title ? (
        <figcaption className="mt-1.5 text-xs text-muted-foreground">{title}</figcaption>
      ) : null}
    </figure>
  );
}
