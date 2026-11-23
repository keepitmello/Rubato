// The changes a companion proposed in its room (proposalModel.ts), from the Mac's /rubato/companion
// route: `proposals` lists them, `apply-proposal` writes one (the only way a proposal reaches the
// companion's files), `decline-proposal` closes it and writes nothing. The room asks again every few
// seconds while it is open, the way it asks for its calls.
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { startRoomPoll } from "./roomPoll";

import { decodeProposal, decodeProposals, type Proposal } from "./proposalModel";
import { isRubatoRequestError, postRubato } from "./rubatoHttp";

const ROUTE = "/rubato/companion";
const POLL_MS = 15_000;

const byRoom = new Map<string, readonly Proposal[]>();
const serializedByRoom = new Map<string, string>();
const listeners = new Set<() => void>();
const NONE: readonly Proposal[] = Object.freeze([]);
const roomKey = (environmentId: string, companionId: string) => `${environmentId}:${companionId}`;

function put(key: string, proposals: readonly Proposal[]) {
  const nextJson = JSON.stringify(proposals);
  if (serializedByRoom.get(key) === nextJson) return;
  serializedByRoom.set(key, nextJson);
  byRoom.set(key, proposals);
  for (const listener of listeners) listener();
}

function merge(key: string, proposal: Proposal) {
  const list = byRoom.get(key) ?? NONE;
  put(key, list.some((item) => item.id === proposal.id) ? list.map((item) => (item.id === proposal.id ? proposal : item)) : [...list, proposal]);
}

async function load(environmentId: EnvironmentId, companionId: string, signal?: AbortSignal) {
  const answer = await postRubato<unknown>(environmentId, ROUTE, "proposals", { companionId }, signal ? { signal } : {});
  if (!signal?.aborted) put(roomKey(environmentId, companionId), decodeProposals(answer));
}

/** The Mac would not apply it: the text changed since the companion proposed this. */
export const isStaleProposal = (error: unknown) => isRubatoRequestError(error) && error.code === "stale";

async function decide(environmentId: EnvironmentId, companionId: string, proposalId: string, action: "apply-proposal" | "decline-proposal") {
  const answer = await postRubato<{ proposal?: unknown }>(environmentId, ROUTE, action, { companionId, proposalId }).catch(
    async (error: unknown) => {
      // Stale or already closed (on the desktop, say): the card shows what the Mac now holds.
      if (isRubatoRequestError(error) && error.status === 409) await load(environmentId, companionId).catch(() => undefined);
      throw error;
    },
  );
  const proposal = decodeProposal(answer.proposal);
  if (proposal) merge(roomKey(environmentId, companionId), proposal);
  return proposal;
}

/** Decided elsewhere first: nothing to tell the person, the card already moved on. */
export const isClosedProposal = (error: unknown) => isRubatoRequestError(error) && error.code === "closed";

export const proposalActions = {
  apply: (environmentId: EnvironmentId, companionId: string, proposalId: string) =>
    decide(environmentId, companionId, proposalId, "apply-proposal"),
  decline: (environmentId: EnvironmentId, companionId: string, proposalId: string) =>
    decide(environmentId, companionId, proposalId, "decline-proposal"),
};

/** A companion's proposals while its room is open; a Mac without the action leaves the list empty. */
export function useProposals(environmentId: EnvironmentId | null, companionId: string, visible: boolean): readonly Proposal[] {
  const key = environmentId === null ? null : roomKey(environmentId, companionId);
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  const proposals = useSyncExternalStore(subscribe, () => (key === null ? NONE : (byRoom.get(key) ?? NONE)));
  useEffect(() => {
    if (!visible || environmentId === null) return;
    return startRoomPoll(POLL_MS, (signal) => load(environmentId, companionId, signal));
  }, [environmentId, companionId, visible]);
  return proposals;
}
