import type { RubatoUpdateAction, RubatoUpdateState } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle,
} from "../ui/dialog";

/**
 * Local desktop only. Remote browsers and mobile cannot start host updates.
 *
 * The dialog asks and reports a failure; it never covers the app while the update runs. The
 * update downloads and rebuilds in the background and restarts once running tool calls finish,
 * so the person keeps working. Settings > About shows it and offers "Update now".
 */
export function RubatoUpdateDialog() {
  const [state, setState] = useState<RubatoUpdateState>({ phase: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [responding, setResponding] = useState(false);
  const inFlight = useRef(false);
  const bridge = window.desktopBridge?.rubatoUpdate;

  useEffect(() => {
    if (!bridge || window.desktopBridge?.getClientPlatform?.() !== "darwin") return;
    let disposed = false;
    let receivedEvent = false;
    const unsubscribe = bridge.onState((next) => {
      receivedEvent = true;
      setState(next);
      setError(null);
    });
    void bridge.getState().then((next) => {
      if (!disposed && !receivedEvent) setState(next);
    }).catch((cause) => console.warn("Rubato update state:", cause));
    return () => { disposed = true; unsubscribe(); };
  }, [bridge]);

  const respond = async (action: RubatoUpdateAction) => {
    if (!bridge || !state.id || inFlight.current) return;
    inFlight.current = true;
    setResponding(true);
    setError(null);
    try {
      await bridge.respond(state.id, action);
      if (action === "update") {
        toastManager.add({
          type: "info",
          title: "Update scheduled",
          description: "Rubato downloads and rebuilds in the background, then restarts once running tool calls finish. Settings > About can restart it now instead.",
        });
      }
    }
    catch {
      setError("Could not send the request. Try again in a moment.");
      // The prompt may have expired behind us (window reopened, app state
      // reset). Resync so a dead prompt cannot trap the user in a modal.
      void bridge.getState().then(setState).catch(() => {});
    } finally { inFlight.current = false; setResponding(false); }
  };
  if (state.phase === "idle" || state.phase === "running") return null;
  const failed = state.phase === "failed";
  // Esc / outside click only hides the prompt. Only the "나중에" button snoozes it.
  const dismiss = () => { void respond("dismiss"); };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) dismiss(); }}>
      <DialogPopup showCloseButton={false} bottomStickOnMobile={false} className="w-full max-w-md">
        <DialogHeader>
          <DialogTitle>{state.message}</DialogTitle>
          <DialogDescription>{state.detail}</DialogDescription>
        </DialogHeader>
        {(state.log || error) && (
          <DialogPanel>
            {state.log && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{state.log}</pre>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </DialogPanel>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={responding}
            onClick={() => { void respond(failed ? "log" : "later"); }}>
            {failed ? "View log" : "Later"}
          </Button>
          <Button disabled={responding} onClick={() => { void respond(failed ? "dismiss" : "update"); }}>
            {failed ? "OK" : "Update"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
