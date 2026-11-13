// Companion calls on the phone: the VoIP push token and CallKit (ios/RubatoCallCenter.swift). Null
// where the native module is not built in (Android, Expo Go, tests).
import { requireOptionalNativeModule } from "expo";

export interface RubatoCallInfo {
  readonly uuid: string;
  readonly callId?: string;
  readonly companion?: string;
  readonly title?: string;
  readonly reason?: string | null;
  readonly ringUntil?: number | null;
  readonly direction?: "incoming" | "outgoing";
  /** ringing, connecting, answering or active, as CallKit has it. */
  readonly state?: string;
}

export type RubatoCallEndReason =
  | "answeredElsewhere"
  | "declinedElsewhere"
  | "unanswered"
  | "failed"
  | "remoteEnded";

export interface RubatoCallEvents {
  voipToken: (event: { token: string | null }) => void;
  /** A companion's call is ringing on the system call screen. */
  incoming: (event: RubatoCallInfo) => void;
  /** The person answered on the system call screen. */
  answer: (event: RubatoCallInfo) => void;
  /** The call ended on the phone: `by` is "person" (end or decline) or "system". */
  end: (event: RubatoCallInfo & { by: "person" | "system" }) => void;
  mute: (event: { uuid: string; muted: boolean }) => void;
  error: (event: { uuid: string; message: string }) => void;
}

export interface RubatoCallModule {
  getVoipToken(): string | null;
  activeCalls(): RubatoCallInfo[];
  reportIncomingCall(info: RubatoCallInfo): Promise<boolean>;
  startOutgoingCall(info: RubatoCallInfo): Promise<void>;
  reportConnected(uuid: string): void;
  endCall(uuid: string, reason: RubatoCallEndReason): void;
  requestEnd(uuid: string): void;
  setMuted(uuid: string, muted: boolean): void;
  setSpeaker(on: boolean): void;
  getCompanionRenames(): Record<string, string>;
  setCompanionRename(companionId: string, name: string | null): void;
  setCompanionIdentity(companionId: string, name: string, avatarBase64: string | null): Promise<void>;
  addListener<E extends keyof RubatoCallEvents>(event: E, listener: RubatoCallEvents[E]): { remove(): void };
}

export const RubatoCall = requireOptionalNativeModule<RubatoCallModule>("RubatoCall");
