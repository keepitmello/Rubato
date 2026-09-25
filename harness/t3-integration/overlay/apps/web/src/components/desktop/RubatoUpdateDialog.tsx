import type { RubatoUpdateAction, RubatoUpdateState } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { LoaderCircleIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle,
} from "../ui/dialog";

/** Local desktop only. Remote browsers and mobile cannot start host updates. */
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
    try { await bridge.respond(state.id, action); }
    catch {
      setError("요청을 전달하지 못했어요. 잠시 뒤 다시 눌러 주세요.");
      // The prompt may have expired behind us (window reopened, app state
      // reset). Resync so a dead prompt cannot trap the user in a modal.
      void bridge.getState().then(setState).catch(() => {});
    } finally { inFlight.current = false; setResponding(false); }
  };
  if (state.phase === "idle") return null;
  const running = state.phase === "running";
  const failed = state.phase === "failed";
  // Esc / outside click only hides the prompt. Only the "나중에" button snoozes it.
  const dismiss = () => { if (!running) void respond("dismiss"); };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) dismiss(); }}>
      <DialogPopup showCloseButton={false} bottomStickOnMobile={false} className="w-full max-w-md">
        <DialogHeader>
          <DialogTitle>{running ? "업데이트하고 있어요." : state.message}</DialogTitle>
          <DialogDescription>
            {running
              ? "앱이 잠시 닫혔다가 자동으로 다시 열려요. 따로 터미널을 열 필요는 없어요."
              : state.detail}
          </DialogDescription>
        </DialogHeader>
        {(running || state.log || error) && (
          <DialogPanel>
            {running && (
              <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircleIcon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
                업데이트를 적용하고 있어요.
              </div>
            )}
            {state.log && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{state.log}</pre>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </DialogPanel>
        )}
        {!running && (
          <DialogFooter>
            <Button variant="outline" disabled={responding}
              onClick={() => { void respond(failed ? "log" : "later"); }}>
              {failed ? "오류 기록 보기" : "나중에"}
            </Button>
            <Button disabled={responding} onClick={() => { void respond(failed ? "dismiss" : "update"); }}>
              {failed ? "확인" : "업데이트"}
            </Button>
          </DialogFooter>
        )}
      </DialogPopup>
    </Dialog>
  );
}
