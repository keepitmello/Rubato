// The changes a companion proposed in its room (proposalModel.ts), from the Mac's /rubato/companion
// route: `proposals` lists them, `apply-proposal` writes one (the only way a proposal reaches the
// companion's files), `decline-proposal` closes it and writes nothing. The room asks again every few
// seconds while it is open, the way it asks for its calls.
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { decodeProposal, decodeProposals, type Proposal } from "./proposalModel";
import { isRubatoRequestError, postRubato } from "./rubatoHttp";

const ROUTE = "/rubato/companion";
const POLL_MS = 6_000;

const byRoom = new Map<string, readonly Proposal[]>();
const listeners = new Set<() => void>();
const NONE: readonly Proposal[] = Object.freeze([]);
const roomKey = (environmentId: string, companionId: string) => `${environmentId}:${companionId}`;

function put(key: string, proposals: readonly Proposal[]) {
  byRoom.set(key, proposals);
  for (const listener of listeners) listener();
}

function merge(key: string, proposal: Proposal) {
  const list = byRoom.get(key) ?? NONE;
  put(key, list.some((item) => item.id === proposal.id) ? list.map((item) => (item.id === proposal.id ? proposal : item)) : [...list, proposal]);
}

async function load(environmentId: EnvironmentId, companionId: string) {
  const answer = await postRubato<unknown>(environmentId, ROUTE, "proposals", { companionId });
  put(roomKey(environmentId, companionId), decodeProposals(answer));
}

/** The Mac would not apply it: the text changed since the companion proposed this. */
export const isStaleProposal = (error: unknown) => isRubatoRequestError(error) && (error.code === "stale" || error.status === 409);

async function decide(environmentId: EnvironmentId, companionId: string, proposalId: string, action: "apply-proposal" | "decline-proposal") {
  const answer = await postRubato<{ proposal?: unknown }>(environmentId, ROUTE, action, { companionId, proposalId });
  const proposal = decodeProposal(answer.proposal);
  if (proposal) merge(roomKey(environmentId, companionId), proposal);
  return proposal;
}

export const proposalActions = {
  apply: (environmentId: EnvironmentId, companionId: string, proposalId: string) =>
    decide(environmentId, companionId, proposalId, "apply-proposal"),
  decline: (environmentId: EnvironmentId, companionId: string, proposalId: string) =>
    decide(environmentId, companionId, proposalId, "decline-proposal"),
};

/** A companion's proposals while its room is open; a Mac without the action leaves the list empty. */
export function useProposals(environmentId: EnvironmentId | null, companionId: string): readonly Proposal[] {
  const key = environmentId === null ? null : roomKey(environmentId, companionId);
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  const proposals = useSyncExternalStore(subscribe, () => (key === null ? NONE : (byRoom.get(key) ?? NONE)));
  useEffect(() => {
    if (environmentId === null) return;
    let live = true;
    const ask = () => {
      if (live) void load(environmentId, companionId).catch(() => undefined);
    };
    ask();
    const timer = setInterval(ask, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [environmentId, companionId]);
  return proposals;
}
