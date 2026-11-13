// Calls with companions on the phone. The Mac's call service owns every call
// (harness/companion/call-agent); the phone asks it through /rubato/call (dial, answer, decline,
// hangup, live, calls) and carries the audio over LiveKit, reached on the tailnet
// (call-agent remote.mjs). CallKit shows each call like a phone call: a companion's ring arrives as a
// VoIP push, or from /live while the app is open, and the system call screen answers it
// (modules/rubato-call). The first device to answer takes the call; while a ring shows here the phone
// keeps asking the Mac, and stops ringing once another device took it, it was declined or it ran out.
import { registerGlobals } from "@livekit/react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import { Room, RoomEvent, type Participant } from "livekit-client";
import { useSyncExternalStore } from "react";

import { RubatoCall, type RubatoCallEndReason, type RubatoCallInfo } from "../../../modules/rubato-call";
import { copy } from "./copy";
import { ringCheck, type LiveAnswer } from "./ringCheck";
import { pairedEnvironmentIds, postRubato, RubatoRequestError } from "./rubatoHttp";

registerGlobals();

const CALL_ROUTE = "/rubato/call";
/** How often an open app, or a ring on the call screen, asks the Mac about calls. */
export const RING_POLL_MS = 2_000;
/** How long a call may stay connecting before it is given up with an error. */
export const CONNECT_MS = 20_000;
/** How long an answer from the lock screen waits for the app to reach a Mac. */
const ANSWER_WAIT_MS = 12_000;

export type CallStatus = "ringing" | "active" | "ended" | "missed" | "declined";

export interface CallLine {
  readonly who: "me" | "companion";
  readonly text: string;
  readonly at: number;
}

/** One call as the Mac's call log keeps it (call-agent calls.mjs). */
export interface CallRecord {
  readonly id: string;
  readonly uuid?: string;
  readonly companion: string;
  readonly title?: string | null;
  readonly direction: "outgoing" | "incoming";
  readonly status: CallStatus;
  readonly reason: string | null;
  readonly createdAt: number;
  readonly ringUntil?: number | null;
  readonly answeredAt: number | null;
  readonly endedAt: number | null;
  readonly transcript: readonly CallLine[];
}

interface Joined {
  readonly call: CallRecord;
  readonly url: string;
  readonly token: string;
}

export interface CallableCompanion {
  readonly id: string;
  readonly title?: string;
  readonly ready: boolean;
  readonly reason?: string;
}

export const callApi = {
  live: (env: EnvironmentId) => postRubato<CallRecord[]>(env, CALL_ROUTE, "live", {}, { timeoutMs: 6_000 }),
  calls: (env: EnvironmentId, companion: string, since?: number) =>
    postRubato<CallRecord[]>(env, CALL_ROUTE, "calls", since === undefined ? { companion } : { companion, since }),
  companions: (env: EnvironmentId) => postRubato<CallableCompanion[]>(env, CALL_ROUTE, "companions"),
  dial: (env: EnvironmentId, companion: string) => postRubato<Joined>(env, CALL_ROUTE, "dial", { companion }),
  answer: (env: EnvironmentId, callId: string) => postRubato<Joined>(env, CALL_ROUTE, "answer", { callId }),
  decline: (env: EnvironmentId, callId: string) => postRubato<CallRecord>(env, CALL_ROUTE, "decline", { callId }),
  hangup: (env: EnvironmentId, callId: string) => postRubato<CallRecord>(env, CALL_ROUTE, "hangup", { callId }),
};

/** What the companion is doing on a live call, as LiveKit's agent state names it. */
export type CallAgentState = "connecting" | "listening" | "thinking" | "speaking";

export interface CurrentCall {
  readonly call: CallRecord;
  readonly environmentId: EnvironmentId;
  readonly state: CallAgentState;
  readonly muted: boolean;
  readonly speaker: boolean;
  /** When the audio connected; null while connecting. */
  readonly connectedAt: number | null;
  readonly lines: readonly CallLine[];
  /** CallKit shows this call; false when the system refused it and the app runs the audio itself. */
  readonly callKit: boolean;
}

export interface CallView {
  readonly current: CurrentCall | null;
  /** A companion's ring the app shows itself, only where CallKit is not built in. */
  readonly ringing: (CallRecord & { readonly environmentId: EnvironmentId }) | null;
  readonly error: string | null;
  /** Bumps whenever a call this phone saw ends, so a room fetches its call cards again. */
  readonly version: number;
}

let view: CallView = { current: null, ringing: null, error: null, version: 0 };
const listeners = new Set<() => void>();
function publish(next: Partial<CallView>) {
  view = { ...view, ...next };
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const readCallView = () => view;

export function useCallView(): CallView {
  return useSyncExternalStore(subscribe, readCallView);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── a live call ──────────────────────────────────────────────────────────────────────────────────

let room: Room | null = null;

function update(target: Room, patch: Partial<CurrentCall>) {
  if (room === target && view.current) publish({ current: { ...view.current, ...patch } });
}

async function join(environmentId: EnvironmentId, joined: Joined, callKit: boolean) {
  const next = new Room({
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  room = next;
  publish({
    error: null,
    ringing: null,
    current: {
      call: joined.call,
      environmentId,
      state: "connecting",
      muted: false,
      speaker: false,
      connectedAt: null,
      lines: [],
      callKit,
    },
  });
  // Any failure on the way in ends the call and says why, instead of leaving it connecting.
  const giveUp = setTimeout(() => {
    if (room === next && view.current?.connectedAt === null) void fail(copy.callFailed);
  }, CONNECT_MS);
  const stateOf = (participant: Participant) => {
    const state = participant.attributes["lk.agent.state"];
    if (state === "listening" || state === "thinking" || state === "speaking") update(next, { state });
  };
  next.on(RoomEvent.ParticipantAttributesChanged, (_changed, participant) => stateOf(participant));
  next.on(RoomEvent.ParticipantConnected, (participant) => stateOf(participant));
  next.on(RoomEvent.Disconnected, () => {
    if (room === next) void finish("remoteEnded");
  });
  const segments = new Map<string, CallLine>();
  next.registerTextStreamHandler("lk.transcription", async (reader, participant) => {
    const who = participant.identity === next.localParticipant.identity ? "me" : "companion";
    const segment = reader.info.attributes?.["lk.segment_id"] ?? reader.info.id;
    let text = "";
    for await (const chunk of reader) {
      text += chunk;
      segments.set(segment, { who, text, at: segments.get(segment)?.at ?? Date.now() });
      update(next, { lines: [...segments.values()] });
    }
  });
  try {
    await next.connect(joined.url, joined.token);
    if (room !== next) return;
    await next.localParticipant.setMicrophoneEnabled(true);
    for (const participant of next.remoteParticipants.values()) stateOf(participant);
    update(next, { connectedAt: Date.now(), state: view.current?.state === "connecting" ? "listening" : view.current?.state });
    if (joined.call.uuid) RubatoCall?.reportConnected(joined.call.uuid);
  } catch (error) {
    if (room === next) await fail(message(error));
  } finally {
    clearTimeout(giveUp);
  }
}

async function fail(text: string) {
  await finish("failed");
  publish({ error: text });
}

/** Leaves the call on this phone, tells the Mac and takes it off the system call screen. */
async function finish(reason: RubatoCallEndReason) {
  const current = view.current;
  const ending = room;
  room = null;
  if (current) publish({ current: null, version: view.version + 1 });
  await ending?.disconnect().catch(() => undefined);
  if (!current) return;
  if (current.call.uuid) RubatoCall?.endCall(current.call.uuid, reason);
  if (!current.callKit) RubatoCall?.setAudioWithoutCallKit(false);
  await callApi.hangup(current.environmentId, current.call.id).catch(() => undefined);
}

// ── rings ────────────────────────────────────────────────────────────────────────────────────────

/** Rings the system call screen shows, by CallKit uuid, until they are answered or stop. */
type Ring = RubatoCallInfo & { environmentId?: EnvironmentId };
const rings = new Map<string, Ring>();

/** What every paired Mac says is live now; a Mac that does not answer is marked failed. */
async function liveAnswers(): Promise<LiveAnswer[]> {
  return Promise.all(
    pairedEnvironmentIds().map((environmentId) =>
      callApi.live(environmentId).then(
        (live): LiveAnswer => ({ environmentId, live }),
        (): LiveAnswer => ({ environmentId, failed: true }),
      ),
    ),
  );
}

/** How a ring that is no longer live ended, for CallKit's reason. */
async function endedRingReason(environmentId: EnvironmentId | undefined, ring: RubatoCallInfo): Promise<RubatoCallEndReason> {
  if (environmentId && ring.companion && ring.callId) {
    const past = await callApi.calls(environmentId, ring.companion).catch(() => []);
    const call = past.find((item) => item.id === ring.callId);
    if (call?.status === "active" || call?.status === "ended") return "answeredElsewhere";
    if (call?.status === "declined") return "declinedElsewhere";
  }
  return "unanswered";
}

let ringWatch: ReturnType<typeof setInterval> | null = null;
let ringPollRunning = false;

/**
 * While the system call screen rings, asks the Macs whether the ring is still for this phone. It
 * ends only on a Mac's word (ringCheck); with no Mac reachable it rings on until ringUntil.
 */
function watchRings() {
  if (ringWatch !== null) return;
  ringWatch = setInterval(() => {
    if (rings.size === 0) {
      if (ringWatch !== null) clearInterval(ringWatch);
      ringWatch = null;
      return;
    }
    // A slow Mac must not stack polls on top of each other.
    if (ringPollRunning) return;
    ringPollRunning = true;
    void (async () => {
      try {
        const answers = await liveAnswers();
        for (const [uuid, ring] of rings) {
          if (ring.state !== "ringing" || !ring.callId) continue;
          const check = ringCheck(ring.callId, ring.environmentId, answers);
          if (check.kind === "unknown") continue;
          if (check.kind === "ringing") {
            rings.set(uuid, { ...ring, environmentId: check.environmentId as EnvironmentId });
            continue;
          }
          rings.delete(uuid);
          RubatoCall?.endCall(
            uuid,
            check.kind === "taken" ? "answeredElsewhere" : await endedRingReason(check.environmentId as EnvironmentId, ring),
          );
        }
      } finally {
        ringPollRunning = false;
      }
    })();
  }, RING_POLL_MS);
}

function onIncoming(info: RubatoCallInfo) {
  rings.set(info.uuid, { ...info, state: "ringing" });
  watchRings();
}

/** The person answered on the system call screen, maybe before the app had reached any Mac. */
async function onAnswer(info: RubatoCallInfo) {
  const ring: Ring = rings.get(info.uuid) ?? info;
  rings.set(info.uuid, { ...ring, state: "answering" });
  if (!ring.callId) {
    rings.delete(info.uuid);
    RubatoCall?.endCall(info.uuid, "failed");
    return;
  }
  const until = Date.now() + ANSWER_WAIT_MS;
  let lastError: unknown = null;
  while (Date.now() < until) {
    const order = [ring.environmentId, ...pairedEnvironmentIds()].filter(
      (id, index, all): id is EnvironmentId => id !== undefined && all.indexOf(id) === index,
    );
    for (const environmentId of order) {
      try {
        const joined = await callApi.answer(environmentId, ring.callId);
        rings.delete(info.uuid);
        await join(environmentId, { ...joined, call: { ...joined.call, uuid: joined.call.uuid ?? info.uuid } }, true);
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof RubatoRequestError && error.status === 409) {
          // Taken on another device, or over: the ring here ends with that reason.
          rings.delete(info.uuid);
          RubatoCall?.endCall(info.uuid, /elsewhere/.test(error.message) ? "answeredElsewhere" : "unanswered");
          publish({ error: /elsewhere/.test(error.message) ? copy.answeredElsewhere : null });
          return;
        }
        // 404: another Mac's call; anything else: this Mac is not reachable yet.
      }
    }
    await wait(800);
  }
  rings.delete(info.uuid);
  RubatoCall?.endCall(info.uuid, "failed");
  publish({ error: lastError ? message(lastError) : copy.callFailed });
}

/** The person ended the call or declined the ring on the system call screen. */
async function onEnd(info: RubatoCallInfo & { by: "person" | "system" }) {
  if (view.current?.call.uuid === info.uuid) {
    await finish("remoteEnded");
    return;
  }
  const ring = rings.get(info.uuid);
  rings.delete(info.uuid);
  const callId = ring?.callId ?? info.callId;
  if (!callId || info.by !== "person") return;
  const order = [ring?.environmentId, ...pairedEnvironmentIds()].filter(
    (id, index, all): id is EnvironmentId => id !== undefined && all.indexOf(id) === index,
  );
  for (const environmentId of order) {
    try {
      await callApi.decline(environmentId, callId);
      break;
    } catch {
      // Not this Mac's call, or already over.
    }
  }
  publish({ version: view.version + 1 });
}

async function onMute(event: { uuid: string; muted: boolean }) {
  if (!room || view.current?.call.uuid !== event.uuid) return;
  const target = room;
  await target.localParticipant.setMicrophoneEnabled(!event.muted).catch(() => undefined);
  update(target, { muted: event.muted });
}

/**
 * A ring found while the app is open: shown on the system call screen (CallKit lets an app report a
 * call any time), or in the app itself where CallKit is not built in.
 */
export async function pollLiveRings() {
  for (const environmentId of pairedEnvironmentIds()) {
    let live: CallRecord[];
    try {
      live = await callApi.live(environmentId);
    } catch {
      continue;
    }
    const ringing = live.find((call) => call.status === "ringing" && call.direction === "incoming");
    if (!RubatoCall) {
      if (view.current) continue;
      if (ringing?.id !== view.ringing?.id) publish({ ringing: ringing ? { ...ringing, environmentId } : null });
      continue;
    }
    if (!ringing?.uuid || rings.has(ringing.uuid) || view.current?.call.id === ringing.id) continue;
    const info: RubatoCallInfo = {
      uuid: ringing.uuid,
      callId: ringing.id,
      companion: ringing.companion,
      title: ringing.title ?? ringing.companion,
      reason: ringing.reason,
      ringUntil: ringing.ringUntil ?? null,
      direction: "incoming",
    };
    rings.set(info.uuid, { ...info, state: "ringing", environmentId });
    await RubatoCall.reportIncomingCall(info).catch(() => false);
    watchRings();
  }
}

let started = false;

/** Wires the system call screen to this store once; RubatoCallHost calls it as the app starts. */
export function startCallBridge() {
  if (started || !RubatoCall) return;
  started = true;
  RubatoCall.addListener("incoming", onIncoming);
  RubatoCall.addListener("answer", (event) => void onAnswer(event));
  RubatoCall.addListener("end", (event) => void onEnd(event));
  RubatoCall.addListener("mute", (event) => void onMute(event));
  // A ring answered or showing before this ran (the app was launched by the push).
  for (const call of RubatoCall.activeCalls()) {
    if (call.state === "ringing") onIncoming(call);
    if (call.state === "answering") void onAnswer(call);
  }
}

// ── the person's actions ─────────────────────────────────────────────────────────────────────────

export const callActions = {
  async dial(environmentId: EnvironmentId, companion: string, title: string) {
    if (view.current || room) return;
    let joined: Joined;
    try {
      joined = await callApi.dial(environmentId, companion);
    } catch (error) {
      publish({ error: message(error) });
      return;
    }
    let callKit = false;
    if (RubatoCall && joined.call.uuid) {
      try {
        await RubatoCall.startOutgoingCall({
          uuid: joined.call.uuid,
          callId: joined.call.id,
          companion,
          title,
          direction: "outgoing",
        });
        callKit = true;
      } catch {
        // The system refused (another call is on): the app runs the audio itself.
      }
    }
    if (!callKit) RubatoCall?.setAudioWithoutCallKit(true);
    await join(environmentId, joined, callKit);
  },
  /** Answers the app's own ring (only shown where CallKit is not built in). */
  async answer() {
    const ringing = view.ringing;
    if (!ringing) return;
    publish({ ringing: null });
    try {
      const joined = await callApi.answer(ringing.environmentId, ringing.id);
      RubatoCall?.setAudioWithoutCallKit(true);
      await join(ringing.environmentId, joined, false);
    } catch (error) {
      publish({ error: message(error) });
    }
  },
  async decline() {
    const ringing = view.ringing;
    if (!ringing) return;
    publish({ ringing: null, version: view.version + 1 });
    await callApi.decline(ringing.environmentId, ringing.id).catch(() => undefined);
  },
  hangUp() {
    const current = view.current;
    if (!current) return;
    // Through CallKit when it shows the call, so the system screen ends with it.
    if (current.callKit && current.call.uuid && RubatoCall) RubatoCall.requestEnd(current.call.uuid);
    else void finish("remoteEnded");
  },
  setMuted(muted: boolean) {
    const current = view.current;
    if (!current || !room) return;
    if (current.callKit && current.call.uuid && RubatoCall) {
      RubatoCall.setMuted(current.call.uuid, muted);
      return;
    }
    const target = room;
    void target.localParticipant.setMicrophoneEnabled(!muted).then(
      () => update(target, { muted }),
      () => undefined,
    );
  },
  setSpeaker(on: boolean) {
    if (!view.current) return;
    RubatoCall?.setSpeaker(on);
    publish({ current: { ...view.current, speaker: on } });
  },
  dismissError: () => publish({ error: null }),
};
