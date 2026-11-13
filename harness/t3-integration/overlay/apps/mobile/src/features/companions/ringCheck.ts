// Whether a companion's ring on the phone's call screen is still for this phone, from what the
// paired Macs answered to /rubato/call/live. A Mac that did not answer says nothing: a phone woken
// by a VoIP push may not have its VPN back yet, and its ring must not stop because of that. It stops
// only on a Mac's word (taken, or no longer live), or at ringUntil (the native side does that).
import type { CallRecord } from "./callTypes";

export type LiveAnswer =
  | { readonly environmentId: string; readonly live: ReadonlyArray<Pick<CallRecord, "id" | "status">> }
  | { readonly environmentId: string; readonly failed: true };

export type RingCheck =
  | { readonly kind: "ringing"; readonly environmentId: string }
  | { readonly kind: "taken"; readonly environmentId: string }
  | { readonly kind: "gone"; readonly environmentId: string }
  | { readonly kind: "unknown" };

/**
 * `knownEnvironmentId`: the Mac the ring is known to come from; only its answer can end the ring.
 * Without it, the ring is gone only when every paired Mac answered and none has it live.
 */
export function ringCheck(callId: string, knownEnvironmentId: string | undefined, answers: ReadonlyArray<LiveAnswer>): RingCheck {
  for (const answer of answers) {
    if ("failed" in answer) continue;
    const call = answer.live.find((item) => item.id === callId);
    if (!call) continue;
    if (call.status === "ringing") return { kind: "ringing", environmentId: answer.environmentId };
    return { kind: call.status === "active" ? "taken" : "gone", environmentId: answer.environmentId };
  }
  if (knownEnvironmentId !== undefined) {
    const own = answers.find((answer) => answer.environmentId === knownEnvironmentId);
    return own && !("failed" in own) ? { kind: "gone", environmentId: knownEnvironmentId } : { kind: "unknown" };
  }
  const answered = answers.filter((answer) => !("failed" in answer));
  if (answers.length > 0 && answered.length === answers.length) return { kind: "gone", environmentId: answered[0]!.environmentId };
  return { kind: "unknown" };
}
