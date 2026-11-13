// The call service's half of push (harness/companion/call-agent/stack.mjs wires it to the call
// log's onChange): when a companion starts ringing the person, every paired phone gets a VoIP push
// so it rings through CallKit even when the app is closed. A ring is pushed once. Ending a ring is
// not pushed: the ringing phone watches the call itself (it polls /rubato/call/live) and stops it.
import { createGrantStore } from './grants.mjs';

const RING_MS = 40_000;

/** The VoIP push for one ringing call, in the shape the app's CallKit side reads. */
export function ringMessage(call) {
  return {
    kind: 'call.ring',
    callId: call.id,
    uuid: call.uuid,
    companion: call.companion,
    title: call.title || call.companion,
    reason: call.reason ?? null,
    ringUntil: call.ringUntil ?? call.createdAt + RING_MS,
  };
}

export function createPushSender({ grants = createGrantStore({ log: (message, detail) => console.log(message, detail ?? '') }) } = {}) {
  const rung = new Set();
  return {
    /** Fire-and-forget; never throws and never waits, so the ring itself does not depend on push. */
    callChanged(call) {
      if (call?.direction !== 'incoming' || call.status !== 'ringing' || !call.uuid || rung.has(call.id)) return;
      rung.add(call.id);
      if (rung.size > 200) rung.delete(rung.values().next().value);
      void grants.pushAll(ringMessage(call)).catch(() => {});
    },
  };
}
