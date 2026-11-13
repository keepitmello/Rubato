// Calls over the whole app (state/rubatoCall.ts): a companion's ring as a sheet at the top of every
// window with a ringtone, and while a call is on, the same sheet as the call's controls with the
// last thing said. Mounted once at the root, so it rings wherever the person is in the app.
import { MicIcon, MicOffIcon, PhoneIcon, PhoneOffIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { rubatoCompanion, useReadyEnvironmentId, useRubatoCompanion } from "../../state/rubatoCompanion";
import { rubatoCallActions, useRubatoCall, useRubatoCallRinging, type CallAgentState } from "../../state/rubatoCall";
import { callLength, spokenText } from "./rubatoCallRoom";
import "./RubatoCall.css";

const STATE_TEXT: Record<CallAgentState, string> = {
  connecting: "Connecting the call",
  listening: "Listening to you",
  thinking: "Thinking it over",
  speaking: "Talking",
};

function useAvatar(companion: string | undefined) {
  const env = useReadyEnvironmentId();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!companion || env === null) return;
    let live = true;
    rubatoCompanion.art(env, "idle", companion).then((answer) => { if (live) setUrl(answer.art.url); }, () => undefined);
    return () => { live = false; };
  }, [companion, env]);
  return url;
}

function useClock(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

export function RubatoCallLayer() {
  const env = useReadyEnvironmentId();
  const companions = useRubatoCompanion().companions;
  const titleOf = (id: string) => companions.find((item) => item.id === id)?.title ?? id;
  useRubatoCallRinging(titleOf);
  const { ringing, current, error } = useRubatoCall();
  const shown = current?.call ?? ringing;
  const avatar = useAvatar(shown?.companion);
  const now = useClock(current !== null);
  if (error && !shown)
    return (
      <div data-rubato-call-layer="">
        <div data-rubato-call-sheet="" role="alert">
          <span data-rubato-call-who="">
            <span data-rubato-call-name="">Call failed</span>
            <span data-rubato-call-what="">{error}</span>
          </span>
          <button type="button" data-rubato-call-round="" data-kind="mute" aria-label="Close this notice" onClick={rubatoCallActions.dismissError}>
            ×
          </button>
        </div>
      </div>
    );
  if (!shown) return null;
  const name = titleOf(shown.companion);
  const last = current?.lines.at(-1);
  return (
    <div data-rubato-call-layer="">
      <div data-rubato-call-sheet="" data-ringing={current ? undefined : ""} role={current ? "status" : "alertdialog"}>
        {avatar ? <img data-rubato-call-avatar="" src={avatar} alt="" /> : <span data-rubato-call-avatar="" />}
        <span data-rubato-call-who="">
          <span data-rubato-call-name="">{name}</span>
          {current ? (
            <>
              <span data-rubato-call-what="">
                <span>{STATE_TEXT[current.state]}</span>
                {current.call.answeredAt ? ` · ${callLength(now - current.call.answeredAt)}` : null}
              </span>
              {last ? <span data-rubato-call-caption="">{spokenText(last.text)}</span> : null}
            </>
          ) : (
            <span data-rubato-call-what="">{shown.reason ? spokenText(shown.reason) : <span>is calling</span>}</span>
          )}
        </span>
        {current ? (
          <>
            <button type="button" data-rubato-call-round="" data-kind="mute" aria-pressed={current.muted}
              aria-label={current.muted ? "Unmute the call" : "Mute the call"} onClick={() => void rubatoCallActions.mute(!current.muted)}>
              {current.muted ? <MicOffIcon className="size-4.5" /> : <MicIcon className="size-4.5" />}
            </button>
            <button type="button" data-rubato-call-round="" data-kind="hangup" aria-label="Hang up" onClick={() => void rubatoCallActions.hangup()}>
              <PhoneOffIcon className="size-4.5" />
            </button>
          </>
        ) : (
          <>
            <button type="button" data-rubato-call-round="" data-kind="hangup" aria-label="Decline the call" onClick={() => void rubatoCallActions.decline(env)}>
              <PhoneOffIcon className="size-4.5" />
            </button>
            <button type="button" data-rubato-call-round="" data-kind="answer" aria-label="Answer the call" onClick={() => void rubatoCallActions.answer(env)}>
              <PhoneIcon className="size-4.5" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
