// Floating right overlay drawer for a companion room's attachments and HTML previews.
// Mounts via a portal onto the companion space root (RubatoSegnoSpace.tsx) so it floats over
// the character stage and records panel without shrinking the chat column or colliding with the
// stage. The chat column stays interactive beside it; an expand control widens the overlay across
// the room like a centered modal when more horizontal space is needed.
import { Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useCompanionOverlayHost } from "./RubatoSegnoSpace";

const DRAWER_WIDTH_STORAGE_KEY = "rubato:companion-drawer-width";
const DRAWER_MIN_WIDTH_PX = 380;
const DRAWER_DEFAULT_RATIO = 0.56;
const DRAWER_DEFAULT_MAX_PX = 920;
const DRAWER_MAX_RATIO = 0.85;
/** Below this host width, the drawer expands across the room so it never crushes itself. */
const DRAWER_NARROW_HOST_PX = 820;
const DRAWER_INSET_PX = 8;

const BLOCKING_POPUP_SELECTOR = [
  '[data-slot="dialog-popup"]',
  '[data-slot="alert-dialog-popup"]',
  '[data-slot="command-dialog-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

function readStoredWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(DRAWER_WIDTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= DRAWER_MIN_WIDTH_PX ? Math.round(parsed) : null;
  } catch {
    return null;
  }
}

function writeStoredWidth(width: number): void {
  try {
    window.localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Private mode or restricted storage: width lasts this session.
  }
}

/** Pure drawer width math for a given host width and optional user-dragged width. */
export function resolveCompanionDrawerWidth(hostWidth: number, storedWidth: number | null): number | null {
  if (!Number.isFinite(hostWidth) || hostWidth <= 0) return null;
  if (hostWidth < DRAWER_NARROW_HOST_PX) return null;
  const maxWidth = Math.max(DRAWER_MIN_WIDTH_PX, Math.floor(hostWidth * DRAWER_MAX_RATIO));
  const preferred =
    storedWidth ??
    Math.min(DRAWER_DEFAULT_MAX_PX, Math.max(DRAWER_MIN_WIDTH_PX, Math.round(hostWidth * DRAWER_DEFAULT_RATIO)));
  return Math.min(maxWidth, Math.max(DRAWER_MIN_WIDTH_PX, preferred));
}

export function CompanionOverlayControls(props: {
  readonly maximized: boolean;
  readonly onToggleMaximized: () => void;
  readonly onClose: () => void;
}) {
  const expandLabel = props.maximized ? "Restore size" : "Expand viewer";
  return (
    <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]" data-rubato-companion-overlay-controls="">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              aria-label={expandLabel}
              aria-pressed={props.maximized}
              data-rubato-companion-overlay-expand=""
              onClick={props.onToggleMaximized}
            />
          }
        >
          {props.maximized ? <Minimize2Icon className="size-3.5" /> : <Maximize2Icon className="size-3.5" />}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{expandLabel}</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Close"
              data-rubato-companion-overlay-close=""
              onClick={props.onClose}
            />
          }
        >
          <XIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Close</TooltipPopup>
      </Tooltip>
    </div>
  );
}

export function RubatoCompanionOverlayDrawer(props: {
  readonly open: boolean;
  readonly maximized: boolean;
  readonly onToggleMaximized: () => void;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const host = useCompanionOverlayHost();
  const [hostWidth, setHostWidth] = useState<number>(() => host?.clientWidth ?? 0);
  const [storedWidth, setStoredWidth] = useState<number | null>(() => readStoredWidth());
  const [dragging, setDragging] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!host) return;
    const measure = () => setHostWidth(host.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [host]);

  // Escape closes the overlay unless a nested dialog/menu owns Escape.
  useEffect(() => {
    if (!props.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (document.querySelector(BLOCKING_POPUP_SELECTOR)) return;
      event.preventDefault();
      props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.open, props.onClose]);

  // Keep any embedded native browser preview slot aligned after open/maximize/width changes.
  useEffect(() => {
    if (!props.open) return;
    const frame = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.open, props.maximized, storedWidth, hostWidth]);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (props.maximized || !host || hostWidth < DRAWER_NARROW_HOST_PX) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth =
        drawerRef.current?.getBoundingClientRect().width ??
        resolveCompanionDrawerWidth(hostWidth, storedWidth) ??
        DRAWER_MIN_WIDTH_PX;
      const maxWidth = Math.max(DRAWER_MIN_WIDTH_PX, Math.floor(hostWidth * DRAWER_MAX_RATIO));
      let latest = startWidth;
      setDragging(true);

      const onMove = (moveEvent: PointerEvent) => {
        const delta = startX - moveEvent.clientX;
        latest = Math.min(maxWidth, Math.max(DRAWER_MIN_WIDTH_PX, Math.round(startWidth + delta)));
        setStoredWidth(latest);
      };
      const onEnd = () => {
        setDragging(false);
        writeStoredWidth(latest);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
    },
    [host, hostWidth, props.maximized, storedWidth],
  );

  if (!props.open) return null;

  const computedWidth = resolveCompanionDrawerWidth(hostWidth, storedWidth);
  const fullWidth = props.maximized || computedWidth === null;

  const overlay = (
    <>
      {props.maximized ? (
        <div
          aria-hidden="true"
          data-rubato-companion-overlay-backdrop=""
          onClick={props.onToggleMaximized}
          className="absolute inset-0 z-30 bg-black/45 backdrop-blur-[2px] [-webkit-app-region:no-drag]"
        />
      ) : null}
      <div
        ref={drawerRef}
        role="region"
        aria-label="Attachment viewer"
        data-rubato-companion-overlay=""
        data-maximized={props.maximized ? "true" : "false"}
        data-dragging={dragging ? "true" : undefined}
        style={
          fullWidth
            ? undefined
            : {
                width: `${computedWidth}px`,
                top: DRAWER_INSET_PX,
                right: DRAWER_INSET_PX,
                bottom: DRAWER_INSET_PX,
              }
        }
        className={cn(
          "absolute z-40 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl [-webkit-app-region:no-drag]",
          props.maximized ? "inset-3" : fullWidth ? "inset-2" : "",
        )}
      >
        {!fullWidth ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
            data-rubato-companion-overlay-resize=""
            onPointerDown={startResize}
            className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize hover:bg-primary/25 active:bg-primary/40"
          />
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{props.children}</div>
      </div>
    </>
  );

  return host ? createPortal(overlay, host) : overlay;
}
