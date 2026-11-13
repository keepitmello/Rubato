// The call button in a companion room's composer, beside dictation (user 2e97849e: where the person
// types, as Pickle's composer has it). Only a companion's thread shows it, and not while a call is on;
// a companion that cannot be called shows it off, with the reason on hover.
import type { EnvironmentId } from "@t3tools/contracts";
import { PhoneIcon } from "lucide-react";

import { useRubatoCompanion } from "../../state/rubatoCompanion";
import { rubatoCallActions, useCallableCompanion, useRubatoCall } from "../../state/rubatoCall";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function RubatoCallComposerButton(props: { environmentId: EnvironmentId; threadId: string | null }) {
  const companion = useRubatoCompanion().companions.find((item) => props.threadId !== null && item.threadId === props.threadId);
  const callable = useCallableCompanion(props.environmentId, companion?.id);
  const onCall = useRubatoCall().current !== null;
  if (!companion || !callable || onCall) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            // Off but still hoverable, so the reason shows.
            aria-disabled={!callable.ready}
            className={callable.ready ? undefined : "opacity-45"}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => { if (callable.ready) void rubatoCallActions.dial(props.environmentId, companion.id); }}
            aria-label="Start a call"
          />
        }
      >
        <PhoneIcon />
      </TooltipTrigger>
      <TooltipPopup>{callable.ready ? "Start a call" : callable.reason}</TooltipPopup>
    </Tooltip>
  );
}
