// A call as the Mac's call log keeps it (harness/companion/call-agent calls.mjs), shared by the
// call store, the room and the ring check without them importing each other.

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
