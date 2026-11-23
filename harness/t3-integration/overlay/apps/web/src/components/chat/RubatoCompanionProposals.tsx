// What a companion proposes in its room (intent companion-manage, "change by talking"): a card with
// the changed excerpt as a word diff (or the new picture), its own words for the change, Apply and
// "Rewrite more". Nothing is saved before Apply; "Rewrite more" is an ordinary message, so it only puts the caret in
// the composer, and the companion's next proposal for the same text replaces this one. A card whose
// text moved under it (409 stale) asks for the change again instead of failing.
//
// While a new companion is still getting to know the person, chips at the top of its room show which
// topics are settled, which are open and which were left for later.
import { CheckIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { startRoomPoll } from "@t3tools/shared/rubatoRoomPoll";
import { useRubatoRoomVisible } from "../../hooks/useRubatoRoomVisible";

import { uiLanguage } from "../../rubatoI18n";
import {
  acceptCompanionAvatar,
  acceptCompanionIcon,
  rubatoCompanion,
  type CompanionOnboarding,
  type CompanionProposal,
} from "../../state/rubatoCompanion";
import { companionDraft, onboardingChips, wordDiff } from "../../state/rubatoCompanionModel";
import { RubatoRequestError } from "../../state/rubatoHttp";
import { useComposerDraftStore } from "../../composerDraftStore";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { focusRoomComposer } from "./RubatoCompanionFace";

/** How often an open room looks for new proposals; the companion writes them during its turns. */
const PROPOSALS_POLL_MS = 5_000;

/** The companion's proposals, kept fresh while its room is open; `poke` asks again at once. */
export function useCompanionProposals(
  environmentId: EnvironmentId | null | undefined,
  companionId: string | undefined,
  poke: unknown,
) {
  const [proposals, setProposals] = useState<readonly CompanionProposal[]>([]);
  const visible = useRubatoRoomVisible(Boolean(environmentId && companionId));
  const [revision, bump] = useState(0);
  const refresh = useCallback(() => bump((v) => v + 1), []);
  useEffect(() => {
    if (!visible || !environmentId || !companionId) return;
    return startRoomPoll(PROPOSALS_POLL_MS, async (signal) => {
      const answer = await rubatoCompanion.proposals(environmentId, companionId, signal);
      if (!signal.aborted) setProposals(Array.isArray(answer?.proposals) ? answer.proposals : []);
    });
  }, [visible, environmentId, companionId, poke, revision]);
  const update = useCallback((next: CompanionProposal) => {
    setProposals((current) => current.map((item) => (item.id === next.id ? next : item)));
  }, []);
  return { proposals, refresh, update };
}

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <p data-rubato-proposal-diff="" translate="no" className="whitespace-pre-wrap break-words">
      {wordDiff(before, after).map((part, index) =>
        part.kind === "same" ? (
          <span key={index}>{part.text}</span>
        ) : part.kind === "removed" ? (
          <del key={index} data-rubato-proposal-removed="">
            {part.text}
          </del>
        ) : (
          <ins key={index} data-rubato-proposal-added="">
            {part.text}
          </ins>
        ),
      )}
    </p>
  );
}

export function RubatoProposalCard({
  proposal,
  companionId,
  environmentId,
  threadId,
  onUpdate,
  onRefresh,
}: {
  proposal: CompanionProposal;
  companionId: string;
  environmentId: EnvironmentId | null | undefined;
  threadId: string | null | undefined;
  onUpdate: (next: CompanionProposal) => void;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    if (!environmentId || busy) return;
    setBusy(true);
    try {
      const { proposal: next } = await rubatoCompanion.applyProposal(environmentId, companionId, proposal.id);
      onUpdate(next);
      // An applied picture is the companion's picture now, everywhere.
      if (next.kind === "avatar") {
        const answer = await rubatoCompanion.avatar(environmentId, companionId).catch(() => null);
        if (answer) acceptCompanionAvatar(companionId, answer.avatar, true);
      } else if (next.kind === "icon") {
        const answer = await rubatoCompanion.icon(environmentId, companionId).catch(() => null);
        if (answer) acceptCompanionIcon(companionId, answer.icon);
      }
    } catch (cause) {
      if (cause instanceof RubatoRequestError && cause.code === "stale") onUpdate({ ...proposal, status: "stale" });
      else if (cause instanceof RubatoRequestError && cause.code === "closed") onRefresh();
      else
        toastManager.add({
          type: "error",
          title: "Could not apply the change",
          description: cause instanceof Error ? cause.message : String(cause),
        });
    }
    setBusy(false);
  };
  const askAgain = () => {
    if (environmentId && threadId)
      useComposerDraftStore
        .getState()
        .setPrompt(scopeThreadRef(environmentId, ThreadId.make(threadId)), companionDraft("again", uiLanguage() === "ko" ? "ko" : "en"));
    focusRoomComposer();
  };
  return (
    <div data-rubato-segno-row="" data-side="segno" data-rubato-proposal-row="">
      <section data-rubato-proposal="" data-kind={proposal.kind} data-status={proposal.status} aria-label="Proposed change">
        <header data-rubato-proposal-label="" translate="no">
          {proposal.label}
        </header>
        {proposal.kind === "avatar" && proposal.image ? (
          <img data-rubato-proposal-image="" src={proposal.image.url} alt="" draggable={false} />
        ) : null}
        {proposal.kind === "icon" && proposal.image ? (
          <div className="grid size-9 place-items-center rounded-md bg-muted" aria-label="Sidebar icon preview">
            <img src={proposal.image.url} alt="" draggable={false} className="size-6 object-contain" />
          </div>
        ) : null}
        {proposal.kind === "piece" && proposal.before !== undefined && proposal.after !== undefined ? (
          <Diff before={proposal.before} after={proposal.after} />
        ) : null}
        {proposal.status === "open" ? (
          <div data-rubato-proposal-actions="">
            <Button size="xs" disabled={busy || !environmentId} onClick={() => void apply()}>
              Apply
            </Button>
            <Button size="xs" variant="outline" disabled={busy} onClick={focusRoomComposer}>
              Rewrite more
            </Button>
          </div>
        ) : proposal.status === "stale" ? (
          <div data-rubato-proposal-actions="" data-rubato-proposal-stale="">
            <span>The text changed since this was written.</span>
            <Button size="xs" variant="outline" onClick={askAgain}>
              Ask again
            </Button>
          </div>
        ) : (
          <div data-rubato-proposal-done="">
            {proposal.status === "applied" ? (
              <>
                <CheckIcon aria-hidden="true" className="size-3.5" />
                <span>Applied</span>
              </>
            ) : (
              <span>Not applied</span>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/** The onboarding's topics at the top of a new companion's room: set ✓, open, or left for later. */
export function RubatoOnboardingChips({ onboarding }: { onboarding: CompanionOnboarding | null | undefined }) {
  const chips = onboardingChips(onboarding);
  if (chips.length === 0) return null;
  return (
    <div data-rubato-companion-onboarding="" className="pointer-events-none absolute inset-x-0 top-12 z-20 flex justify-center px-4">
      <ul aria-label="Getting to know each other" className="pointer-events-auto chat-content-lane flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <li
            key={chip.key}
            data-rubato-onboarding-chip={chip.key}
            data-state={chip.state}
            data-required={chip.required ? "" : undefined}
            title={chip.value}
          >
            <span>{chip.label}</span>
            {chip.state === "set" ? <CheckIcon aria-hidden="true" className="size-3" /> : null}
            {chip.state === "deferred" ? <small>Later</small> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
