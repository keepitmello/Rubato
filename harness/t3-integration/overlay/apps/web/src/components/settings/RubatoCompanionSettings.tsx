// Settings › Companion: turning Segno on, its heartbeat and daily report, and the pieces its
// system prompt is made of. The server half is harness/t3-integration/src/companion/service.mjs
// over harness/companion. A saved piece reaches Segno on its next request; the tools piece
// follows the product and only reads here.
import { RotateCcwIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import {
  acceptCompanionStatus,
  rubatoCompanion,
  useReadyEnvironmentId,
  useRubatoCompanion,
  type CompanionPiece,
  type CompanionPieceId,
  type CompanionSettingsPatch,
} from "../../state/rubatoCompanion";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const PIECE_COPY: Readonly<Record<CompanionPieceId, { title: string; description: string }>> = {
  preamble: {
    title: "Preamble",
    description: "The first words Segno reads: its name and its welcome.",
  },
  soul: { title: "Soul", description: "Who Segno is and how it speaks." },
  identity: { title: "Identity", description: "Name, look and what stays the same." },
  user: {
    title: "About you",
    description: "Your business, your repositories, how you like to be told things.",
  },
  companion: { title: "How Segno works", description: "Leads, approvals, reports, heartbeat." },
  tools: {
    title: "Tools",
    description: "The tools Segno has. It follows Rubato and cannot be changed.",
  },
};

function reportError(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
}

function minutesLabel(minutes: number): string {
  if (minutes < 60) return `Every ${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? "Every hour" : `Every ${hours} hours`;
}

function PieceEditor({
  piece,
  busy,
  onSave,
}: {
  piece: CompanionPiece;
  busy: boolean;
  onSave: (text: string) => Promise<void>;
}) {
  const current = piece.personalText ?? piece.defaultText;
  const [open, setOpen] = useState(false);
  // The parent keys this editor by the saved text, so a save starts a fresh draft.
  const [draft, setDraft] = useState(current);
  const copy = PIECE_COPY[piece.id];
  const changed = draft.trim() !== current.trim();
  return (
    <SettingsRow
      id={`rubato-companion-piece-${piece.id}`}
      title={copy.title}
      description={copy.description}
      status={piece.personalText !== undefined ? <Badge variant="outline">Yours</Badge> : null}
      control={
        <Button size="sm" variant="outline" onClick={() => setOpen((value) => !value)}>
          {open ? "Close" : piece.editable ? "Edit" : "View"}
        </Button>
      }
    >
      {open ? (
        <div className="mt-3 flex flex-col gap-2">
          <Textarea
            className="min-h-48"
            value={draft}
            readOnly={!piece.editable}
            aria-label={copy.title}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
          />
          {piece.editable ? (
            <div className="flex justify-end gap-2">
              {piece.personalText !== undefined ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onSave("")}>
                  <RotateCcwIcon className="size-3.5" />
                  Back to default
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !changed}
                onClick={() => setDraft(current)}
              >
                Discard
              </Button>
              <Button size="sm" disabled={busy || !changed} onClick={() => void onSave(draft)}>
                {busy ? <Spinner className="size-3.5" /> : null}
                Save
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </SettingsRow>
  );
}

export function RubatoCompanionSettingsPanel() {
  const navigate = useNavigate();
  const environmentId = useReadyEnvironmentId();
  const { status, threadId } = useRubatoCompanion();
  const [pieces, setPieces] = useState<CompanionPiece[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPieces = useCallback(async () => {
    if (environmentId === null) return;
    try {
      setPieces((await rubatoCompanion.pieces(environmentId)).pieces);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [environmentId]);
  useEffect(() => {
    void loadPieces();
  }, [loadPieces]);

  const save = async (patch: CompanionSettingsPatch) => {
    setBusy(true);
    try {
      acceptCompanionStatus(await rubatoCompanion.saveSettings(environmentId, patch));
    } catch (cause) {
      reportError("Could not save the companion settings", cause);
    } finally {
      setBusy(false);
    }
  };
  const savePiece = async (id: CompanionPieceId, text: string) => {
    setBusy(true);
    try {
      setPieces((await rubatoCompanion.savePiece(environmentId, id, text)).pieces);
    } catch (cause) {
      reportError("Could not save the piece", cause);
    } finally {
      setBusy(false);
    }
  };

  const settings = status?.settings;
  const enabled = settings?.enabled === true;
  const state = !enabled ? null : threadId !== null ? (
    <Badge variant="success">On</Badge>
  ) : (
    <Badge variant="outline">Starting</Badge>
  );

  return (
    <>
      <SettingsSection id="rubato-companion" title="Segno">
        {error ? <SettingsRow title="Could not read the companion" description={error} /> : null}
        {settings === undefined && !error ? (
          <SettingsRow title="Reading the companion" control={<Spinner className="size-4" />} />
        ) : null}
        {settings ? (
          <>
            <SettingsRow
              id="rubato-companion-enabled"
              title="Segno"
              description="One conversation that is always on. You talk to it; it starts lead conversations for the work, follows them and tells you how they went."
              status={state}
              control={
                <Switch
                  aria-label="Turn Segno on"
                  checked={enabled}
                  disabled={busy}
                  onCheckedChange={(next) => void save({ enabled: next })}
                />
              }
            />
            {enabled ? (
              <SettingsRow
                id="rubato-companion-open"
                title="Talk to Segno"
                description="Segno also has its own button on the left rail."
                control={
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={threadId === null || environmentId === null}
                    onClick={() => {
                      if (threadId === null || environmentId === null) return;
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: { environmentId, threadId },
                      });
                    }}
                  >
                    Open
                  </Button>
                }
              />
            ) : null}
            <SettingsRow
              id="rubato-companion-heartbeat"
              title="Heartbeat"
              description="Segno looks over the work it follows on a schedule and only writes when something needs you."
              control={
                <span className="flex items-center gap-2">
                  <Select
                    value={String(settings.heartbeat.everyMinutes)}
                    onValueChange={(next) => {
                      if (typeof next === "string")
                        void save({ heartbeat: { everyMinutes: Number(next) } });
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-40"
                      aria-label="Heartbeat interval"
                      disabled={busy || !settings.heartbeat.enabled}
                    >
                      <SelectValue>{minutesLabel(settings.heartbeat.everyMinutes)}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {(status?.heartbeatMinutes ?? []).map((minutes) => (
                        <SelectItem key={minutes} value={String(minutes)}>
                          {minutesLabel(minutes)}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <Switch
                    aria-label="Heartbeat"
                    checked={settings.heartbeat.enabled}
                    disabled={busy}
                    onCheckedChange={(next) => void save({ heartbeat: { enabled: next } })}
                  />
                </span>
              }
            />
            <SettingsRow
              id="rubato-companion-daily-report"
              title="Daily report"
              description="Once a day: what came in, what was finished, what is still running and what waits for you."
              control={
                <span className="flex items-center gap-2">
                  <Input
                    nativeInput
                    type="time"
                    aria-label="Daily report time"
                    className="h-8 w-32"
                    disabled={busy || !settings.dailyReport.enabled}
                    value={settings.dailyReport.time}
                    onChange={(event) => {
                      const time = event.target.value;
                      if (/^\d{2}:\d{2}$/.test(time)) void save({ dailyReport: { time } });
                    }}
                  />
                  <Switch
                    aria-label="Daily report"
                    checked={settings.dailyReport.enabled}
                    disabled={busy}
                    onCheckedChange={(next) => void save({ dailyReport: { enabled: next } })}
                  />
                </span>
              }
            />
          </>
        ) : null}
      </SettingsSection>
      <SettingsSection id="rubato-companion-prompt" title="Segno's prompt">
        {pieces === null && !error ? (
          <SettingsRow title="Reading the prompt" control={<Spinner className="size-4" />} />
        ) : null}
        {pieces?.map((piece) => (
          <PieceEditor
            key={`${piece.id}:${piece.personalText ?? ""}`}
            piece={piece}
            busy={busy}
            onSave={(text) => savePiece(piece.id, text)}
          />
        ))}
      </SettingsSection>
    </>
  );
}
