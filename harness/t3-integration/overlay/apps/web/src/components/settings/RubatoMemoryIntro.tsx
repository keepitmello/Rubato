import { useNavigate, useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { rubatoMemory, type DreamModel } from "../../state/rubatoMemory";
import { Button } from "../ui/button";
import {
  Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { DreamModelsEditor, useReadyEnvironmentId } from "./RubatoMemorySettings";

// Once per device: the first time the app is open on a connected Mac, say what the dream is and let
// the user pick its models before it ever runs. The default ladder assumes accounts a new user may not have.
const SEEN_KEY = "rubato.memory.intro.seen";

export function RubatoMemoryIntro() {
  const environmentId = useReadyEnvironmentId();
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const [seen, setSeen] = useState(() => window.localStorage.getItem(SEEN_KEY) === "1");
  const [models, setModels] = useState<readonly DreamModel[] | null>(null);

  useEffect(() => {
    if (seen || environmentId === null) return;
    let cancelled = false;
    rubatoMemory.status(environmentId).then(
      (status) => { if (!cancelled) setModels(status.models); },
      // No memory route on this connection (an older server, a remote browser): nothing to introduce.
      () => {},
    );
    return () => { cancelled = true; };
  }, [seen, environmentId]);

  const close = () => {
    window.localStorage.setItem(SEEN_KEY, "1");
    setSeen(true);
  };
  const change = (next: readonly DreamModel[]) => {
    const previous = models;
    setModels(next);
    rubatoMemory
      .config(environmentId, { models: next.map((entry) => (entry.reasoning ? { model: entry.model, reasoning: entry.reasoning } : { model: entry.model })) })
      .catch((cause: unknown) => {
        setModels(previous);
        toastManager.add({ type: "error", title: "Could not save the models", description: cause instanceof Error ? cause.message : String(cause) });
      });
  };

  // The first-run wizard owns the screen until it is done.
  if (seen || models === null || pathname.startsWith("/welcome")) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogPopup showCloseButton={false} bottomStickOnMobile={false} className="w-full max-w-lg">
        <DialogHeader>
          <DialogTitle>Rubato remembers your projects</DialogTitle>
          <DialogDescription>
            Agents save what they learn in each project: why something was decided, what was tried and dropped.
            Once a day, a <strong>dream</strong> reads your new sessions and tidies that memory on its own. You can
            read and edit everything it keeps in Settings › Memory.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="mb-1 text-sm text-muted-foreground">
            Pick the models the dream may use. Keep one you have an account for at the top.
          </p>
          <DreamModelsEditor models={models} onChange={change} />
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              close();
              void navigate({ to: "/settings/memory" });
            }}
          >
            Open Memory settings
          </Button>
          <Button onClick={close}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
