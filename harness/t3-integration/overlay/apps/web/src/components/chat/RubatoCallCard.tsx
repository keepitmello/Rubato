// A call in a companion's room (user 0d108939): one card for how it went, opened in place to read
// what both sides said. Words come from the call log (harness/companion/call-agent), which hears the
// person and the companion alike; the thread only ever had the person's half.
import { PhoneIcon, PhoneIncomingIcon, PhoneMissedIcon, PhoneOffIcon, PhoneOutgoingIcon } from "lucide-react";
import { useState } from "react";

import type { CallRecord } from "../../state/rubatoCall";
import { callHeadline, spokenText } from "./rubatoCallRoom";
import "./RubatoCall.css";

function Icon({ call }: { call: CallRecord }) {
  if (call.status === "missed") return <PhoneMissedIcon className="size-4.5" />;
  if (call.status === "declined") return <PhoneOffIcon className="size-4.5" />;
  if (call.status === "active" || call.status === "ringing") return <PhoneIcon className="size-4.5" />;
  return call.direction === "incoming" ? <PhoneIncomingIcon className="size-4.5" /> : <PhoneOutgoingIcon className="size-4.5" />;
}

export function RubatoCallCard({ call, title, locale }: { call: CallRecord; title: string; locale: string | undefined }) {
  const [open, setOpen] = useState(false);
  const headline = callHeadline(call);
  const clock = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(call.createdAt);
  const lines = call.transcript.map((line) => ({ ...line, text: spokenText(line.text) })).filter((line) => line.text);
  return (
    <div data-rubato-call-card="" data-status={call.status}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span data-rubato-call-icon="">
          <Icon call={call} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span data-rubato-call-title="">{headline.title}</span>
          <span data-rubato-call-sub="">
            {call.direction === "incoming" ? <span>{title}</span> : null}
            {call.direction === "incoming" ? " · " : null}
            <span>{call.direction === "incoming" ? "Called you" : "You called"}</span>
            {" · "}
            {clock}
          </span>
        </span>
        {headline.length ? <span data-rubato-call-length="">{headline.length}</span> : null}
      </button>
      {open ? (
        <div data-rubato-call-transcript="">
          {lines.length === 0 ? (
            <span data-rubato-call-empty="">Nothing was said on this call.</span>
          ) : (
            lines.map((line, index) => (
              <span key={`${line.at}:${index}`} data-rubato-call-line="" data-who={line.who}>
                {line.text}
              </span>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
