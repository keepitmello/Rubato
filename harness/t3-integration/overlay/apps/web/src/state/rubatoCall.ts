// Voice calls with companions, the app side (harness/companion/call-agent owns calls; the server's
// /rubato/call route passes the person's actions to it, src/call/service.mjs). Any window of the app
// rings when a companion calls, the first device to answer takes the call, and the others stop.
// Audio goes over LiveKit: its browser client is loaded only when a call starts (public/rubato-livekit-client.mjs).
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";

import { uiText } from "../rubatoI18n";
import { postRubato } from "./rubatoHttp";
import { useReadyEnvironmentId } from "./rubatoCompanion";

const CALL_ROUTE = "/rubato/call";
/** How often the app asks whether a companion is calling. */
export const RING_POLL_MS = 1500;

export type CallStatus = "ringing" | "active" | "ended" | "missed" | "declined";
export interface CallLine {
  readonly who: "me" | "companion";
  readonly text: string;
  readonly at: number;
}
export interface CallRecord {
  readonly id: string;
  readonly companion: string;
  /** "outgoing": the person called; "incoming": the companion called. */
  readonly direction: "outgoing" | "incoming";
  readonly status: CallStatus;
  readonly reason: string | null;
  readonly createdAt: number;
  readonly answeredAt: number | null;
  readonly endedAt: number | null;
  readonly transcript: readonly CallLine[];
}
interface Joined {
  readonly call: CallRecord;
  readonly url: string;
  readonly token: string;
}

const act = <T>(env: EnvironmentId | null, action: string, body: Record<string, unknown> = {}) =>
  postRubato<T>(env, CALL_ROUTE, action, body, "voice calls");

export const rubatoCall = {
  live: (env: EnvironmentId | null) => act<CallRecord[]>(env, "live"),
  calls: (env: EnvironmentId | null, companion: string) => act<CallRecord[]>(env, "calls", { companion }),
  dial: (env: EnvironmentId | null, companion: string) => act<Joined>(env, "dial", { companion }),
  answer: (env: EnvironmentId | null, callId: string) => act<Joined>(env, "answer", { callId }),
  decline: (env: EnvironmentId | null, callId: string) => act<CallRecord>(env, "decline", { callId }),
  hangup: (env: EnvironmentId | null, callId: string) => act<CallRecord>(env, "hangup", { callId }),
};

/** What the companion is doing on a live call, as LiveKit's agent state names it. */
export type CallAgentState = "connecting" | "listening" | "thinking" | "speaking";

export interface CallView {
  /** A companion's call ringing on this device, if any. */
  readonly ringing: CallRecord | null;
  /** The call this device is on. */
  readonly current: { readonly call: CallRecord; readonly state: CallAgentState; readonly muted: boolean;
    readonly lines: readonly CallLine[] } | null;
  readonly error: string | null;
  /** Bumps whenever a call this device saw ends, so a room redraws its call cards. */
  readonly version: number;
}

let view: CallView = { ringing: null, current: null, error: null, version: 0 };
const listeners = new Set<() => void>();
function publish(next: Partial<CallView>) {
  view = { ...view, ...next };
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// ── ringing ──────────────────────────────────────────────────────────────────────────────────────

let ringer: { stop(): void } | null = null;
function ringtone(on: boolean) {
  if (on && !ringer) {
    const audio = new AudioContext();
    const gain = audio.createGain();
    gain.gain.value = 0;
    gain.connect(audio.destination);
    const tones = [440, 480].map((frequency) => {
      const tone = audio.createOscillator();
      tone.frequency.value = frequency;
      tone.connect(gain);
      tone.start();
      return tone;
    });
    // Two short rings, then a pause.
    let beat = 0;
    const timer = window.setInterval(() => {
      gain.gain.value = [0.08, 0, 0.08, 0, 0, 0, 0, 0, 0][beat++ % 9] ?? 0;
    }, 220);
    ringer = { stop() { window.clearInterval(timer); for (const tone of tones) tone.stop(); void audio.close(); } };
  }
  if (!on && ringer) { ringer.stop(); ringer = null; }
}

let notice: Notification | null = null;
function notify(call: CallRecord | null, title: string | null) {
  if (call && !notice && title && (document.hidden || !document.hasFocus()) && "Notification" in window
    && Notification.permission !== "denied") {
    const show = () => {
      notice = new Notification(title, { ...(call.reason ? { body: call.reason } : {}), tag: call.id, requireInteraction: true });
      notice.onclick = () => { window.focus(); notice?.close(); };
    };
    if (Notification.permission === "granted") show();
    else void Notification.requestPermission().then((permission) => { if (permission === "granted" && view.ringing?.id === call.id) show(); });
  }
  if (!call && notice) { notice.close(); notice = null; }
}

let polling: number | null = null;
let titleOf: (companion: string) => string = (companion) => companion;
async function poll(env: EnvironmentId) {
  try {
    const live = await rubatoCall.live(env);
    const ringing = live.find((call) => call.status === "ringing") ?? null;
    const shown = view.current ? null : ringing;
    if (shown?.id !== view.ringing?.id) publish({ ringing: shown });
    ringtone(shown !== null);
    notify(shown, shown ? `${titleOf(shown.companion)} · ${uiText("is calling")}` : null);
  } catch {
    // The call service is not running: nothing rings.
  }
}

/** Keeps this window listening for a companion's call while the app is connected. */
export function useRubatoCallRinging(companionTitle: (companion: string) => string) {
  const env = useReadyEnvironmentId();
  titleOf = companionTitle;
  useEffect(() => {
    if (env === null) return;
    void poll(env);
    polling = window.setInterval(() => void poll(env), RING_POLL_MS);
    return () => { if (polling !== null) window.clearInterval(polling); polling = null; ringtone(false); notify(null, null); };
  }, [env]);
}

// ── a live call ──────────────────────────────────────────────────────────────────────────────────

interface LiveKitModule {
  Room: new (options?: unknown) => LiveKitRoom;
  RoomEvent: Record<string, string>;
  Track: { Kind: { Audio: string } };
}
interface LiveKitParticipant {
  readonly identity: string;
  readonly attributes: Readonly<Record<string, string>>;
}
interface LiveKitRoom {
  on(event: string, listener: (...args: never[]) => void): LiveKitRoom;
  connect(url: string, token: string): Promise<void>;
  disconnect(): Promise<void>;
  readonly localParticipant: LiveKitParticipant & { setMicrophoneEnabled(on: boolean): Promise<unknown> };
  readonly remoteParticipants: ReadonlyMap<string, LiveKitParticipant>;
  registerTextStreamHandler(topic: string, handler: (reader: AsyncIterable<string> & {
    info: { id: string; attributes?: Record<string, string> } }, participant: { identity: string }) => void): void;
}
let livekit: Promise<LiveKitModule> | null = null;
const loadLiveKit = () => {
  livekit ??= import(/* @vite-ignore */ new URL("/rubato-livekit-client.mjs", window.location.href).href) as Promise<LiveKitModule>;
  return livekit;
};

let room: LiveKitRoom | null = null;
let player: HTMLAudioElement[] = [];
let callEnv: EnvironmentId | null = null;

async function join(env: EnvironmentId, joined: Joined) {
  callEnv = env;
  publish({ ringing: null, error: null, current: { call: joined.call, state: "connecting", muted: false, lines: [] } });
  ringtone(false); notify(null, null);
  const { Room, RoomEvent, Track } = await loadLiveKit();
  const next = new Room({ audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  room = next;
  const update = (patch: Partial<NonNullable<CallView["current"]>>) => {
    if (room === next && view.current) publish({ current: { ...view.current, ...patch } });
  };
  const stateOf = (participant: LiveKitParticipant) => {
    const state = participant.attributes["lk.agent.state"];
    if (state === "listening" || state === "thinking" || state === "speaking") update({ state });
  };
  next.on(RoomEvent.TrackSubscribed!, ((track: { kind: string; attach(): HTMLAudioElement }) => {
    if (track.kind !== Track.Kind.Audio) return;
    const element = track.attach();
    element.hidden = true;
    document.body.append(element);
    player.push(element);
  }) as never);
  next.on(RoomEvent.ParticipantAttributesChanged!, ((_changed: unknown, participant: LiveKitParticipant) => stateOf(participant)) as never);
  next.on(RoomEvent.ParticipantConnected!, ((participant: LiveKitParticipant) => stateOf(participant)) as never);
  const segments = new Map<string, CallLine>();
  next.registerTextStreamHandler("lk.transcription", async (reader, participant) => {
    const who = participant.identity === next.localParticipant.identity ? "me" : "companion";
    const segment = reader.info.attributes?.["lk.segment_id"] ?? reader.info.id;
    let text = "";
    for await (const chunk of reader) {
      text += chunk;
      segments.set(segment, { who, text, at: segments.get(segment)?.at ?? Date.now() });
      update({ lines: [...segments.values()] });
    }
  });
  next.on(RoomEvent.Disconnected!, (() => void finish()) as never);
  try {
    await next.connect(joined.url, joined.token);
    for (const participant of next.remoteParticipants.values()) stateOf(participant);
    await next.localParticipant.setMicrophoneEnabled(true);
  } catch (error) {
    publish({ error: error instanceof Error ? error.message : String(error) });
    await finish();
  }
}

async function finish() {
  const call = view.current?.call;
  const ending = room;
  room = null;
  for (const element of player) element.remove();
  player = [];
  if (view.current) publish({ current: null, version: view.version + 1 });
  await ending?.disconnect().catch(() => undefined);
  if (call && callEnv) await rubatoCall.hangup(callEnv, call.id).catch(() => undefined);
}

export const rubatoCallActions = {
  async dial(env: EnvironmentId | null, companion: string) {
    if (env === null || view.current) return;
    try { await join(env, await rubatoCall.dial(env, companion)); }
    catch (error) { publish({ error: error instanceof Error ? error.message : String(error) }); }
  },
  async answer(env: EnvironmentId | null) {
    const call = view.ringing;
    if (env === null || !call) return;
    publish({ ringing: null });
    ringtone(false); notify(null, null);
    try { await join(env, await rubatoCall.answer(env, call.id)); }
    catch (error) { publish({ error: error instanceof Error ? error.message : String(error) }); }
  },
  async decline(env: EnvironmentId | null) {
    const call = view.ringing;
    if (env === null || !call) return;
    publish({ ringing: null, version: view.version + 1 });
    ringtone(false); notify(null, null);
    await rubatoCall.decline(env, call.id).catch(() => undefined);
  },
  hangup: () => finish(),
  async mute(on: boolean) {
    if (!room || !view.current) return;
    await room.localParticipant.setMicrophoneEnabled(!on);
    publish({ current: { ...view.current, muted: on } });
  },
  dismissError: () => publish({ error: null }),
};

export function useRubatoCall(): CallView {
  return useSyncExternalStore(subscribe, () => view);
}

// ── a room's calls ───────────────────────────────────────────────────────────────────────────────

/** Whether a companion can be called now, and why not (harness/companion/call-agent companion.mjs). */
export interface CallableCompanion {
  readonly id: string;
  readonly ready: boolean;
  readonly reason?: string;
}

/**
 * A companion's calls for its room, fetched again whenever a call this device saw ends and every
 * so often, so a call taken on another device or a missed ring shows up too.
 */
export function useRoomCalls(env: EnvironmentId | null, companion: string | undefined) {
  const { version, current } = useRubatoCall();
  const [calls, setCalls] = useState<readonly CallRecord[]>([]);
  const [callable, setCallable] = useState<CallableCompanion | null>(null);
  useEffect(() => {
    if (env === null || !companion) return;
    let live = true;
    const load = () => {
      rubatoCall.calls(env, companion).then((list) => { if (live) setCalls(list); }, () => undefined);
      act<CallableCompanion[]>(env, "companions").then(
        (list) => { if (live) setCallable(list.find((item) => item.id === companion) ?? null); }, () => undefined);
    };
    load();
    const timer = window.setInterval(load, current ? 5_000 : 15_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [env, companion, version, current !== null]);
  return { calls, callable };
}
