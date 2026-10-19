// Settings › Companion: turning Segno on, its heartbeat and daily report, the pieces its system
// prompt is made of, and the Telegram messenger it talks through. The server half is
// harness/t3-integration/src/companion/service.mjs over harness/companion. A saved piece reaches
// Segno on its next request; the tools piece follows the product and only reads here.
//
// The Telegram part reads and writes the same files the engine's resident messenger reads
// (harness/companion/messenger/store.mjs): a request is a file, and the answer shows up here a
// second or two later, so this panel polls while it is open.
import { RotateCcwIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  acceptCompanionStatus,
  rubatoCompanion,
  useReadyEnvironmentId,
  useRubatoCompanion,
  type CompanionPiece,
  type CompanionPieceId,
  type CompanionSettingsPatch,
  type TelegramHeldMessage,
  type TelegramStatus,
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


const HELD_KIND = (message: TelegramHeldMessage): string =>
  message.target?.name ?? message.target?.chatId ?? "you";

function TelegramPanel({ environmentId }: { environmentId: EnvironmentId | null }) {
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((next: { telegram: TelegramStatus }) => {
    setTelegram(next.telegram);
    setError(null);
  }, []);

  useEffect(() => {
    if (environmentId === null) return;
    let alive = true;
    const load = async () => {
      try {
        const next = await rubatoCompanion.telegram(environmentId);
        if (alive) apply(next);
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 3_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [environmentId, apply]);

  const run = async (work: () => Promise<{ telegram: TelegramStatus }>) => {
    setBusy(true);
    try {
      apply(await work());
    } catch (cause) {
      reportError("Could not change the Telegram connection", cause);
    } finally {
      setBusy(false);
    }
  };

  const made = telegram?.bot.masked != null;
  const paired = telegram?.pairing.status === "paired";
  const waiting = telegram?.pairing.status === "pending";
  const state = !made ? (
    <Badge variant="outline">No bot yet</Badge>
  ) : paired ? (
    <Badge variant="success">Connected</Badge>
  ) : waiting ? (
    <Badge variant="outline">Waiting for the code</Badge>
  ) : (
    <Badge variant="outline">Not paired</Badge>
  );

  return (
    <SettingsSection id="rubato-companion-telegram" title="Telegram">
      {error ? <SettingsRow title="Could not read the Telegram connection" description={error} /> : null}
      {telegram === null && !error ? (
        <SettingsRow title="Reading the Telegram connection" control={<Spinner className="size-4" />} />
      ) : null}
      {telegram ? (
        <>
          <SettingsRow
            id="rubato-companion-telegram-enabled"
            title="Telegram"
            description="Talk to Segno from your own Telegram chat. Anything Segno writes to someone else waits here for you."
            status={state}
            control={
              <Switch
                aria-label="Telegram"
                checked={telegram.settings.enabled}
                disabled={busy}
                onCheckedChange={(next) => void run(() => rubatoCompanion.saveTelegramSettings(environmentId, { enabled: next }))}
              />
            }
          />
          {!made ? (
            <>
              <SettingsRow
                id="rubato-companion-telegram-token"
                title="Paste the token @BotFather gave you"
                description="In Telegram, open @BotFather, send /newbot, answer its two questions, and paste the token it sends back here."
                control={
                  <span className="flex items-center gap-2">
                    <Input
                      aria-label="Telegram bot token"
                      className="h-8 w-64"
                      placeholder="123456789:AA…"
                      value={token}
                      disabled={busy}
                      onChange={(event) => setToken(event.target.value)}
                    />
                    <Button size="sm" disabled={busy || token.trim() === ""}
                      onClick={() => void run(() => rubatoCompanion.setTelegramToken(environmentId, token.trim()))}>
                      {busy ? <Spinner className="size-3.5" /> : null}
                      Save
                    </Button>
                  </span>
                }
              />
              {telegram.botCreation?.available ? (
                <SettingsRow
                  id="rubato-companion-telegram-create"
                  title="Or let Rubato make it"
                  description="Rubato asks @BotFather from your own Telegram account and keeps the token. Nothing for you to do in Telegram."
                  control={
                    <Button size="sm" variant="outline" disabled={busy}
                      onClick={() => void run(() => rubatoCompanion.createTelegramBot(environmentId, "Segno"))}>
                      {busy ? <Spinner className="size-3.5" /> : null}
                      Create the bot
                    </Button>
                  }
                />
              ) : null}
            </>
          ) : (
            <SettingsRow
              id="rubato-companion-telegram-bot"
              title={telegram.bot.name ?? "Segno's bot"}
              description={telegram.bot.username ? `@${telegram.bot.username}` : "The bot Rubato made for Segno."}
              status={telegram.bot.masked ? <Badge variant="outline">{telegram.bot.masked}</Badge> : null}
            />
          )}
          {telegram.handoff.error ? (
            <SettingsRow id="rubato-companion-telegram-error" title="The last Telegram request failed" description={telegram.handoff.error} />
          ) : null}
          {made && !paired ? (
            <SettingsRow
              id="rubato-companion-telegram-pair"
              title="Pair your chat"
              description="Only the chat that sends this code becomes yours; nothing else counts as you."
              status={waiting && telegram.pairing.code ? <Badge variant="outline">{telegram.pairing.code}</Badge> : null}
              control={
                <Button size="sm" disabled={busy} onClick={() => void run(() => rubatoCompanion.pairTelegram(environmentId))}>
                  {waiting ? "New code" : "Pair"}
                </Button>
              }
            >
              {waiting ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Open the bot in Telegram and send it this code. Send it before the code is replaced.
                </p>
              ) : null}
            </SettingsRow>
          ) : null}
          {paired ? (
            <SettingsRow
              id="rubato-companion-telegram-chat"
              title="Your chat"
              description={telegram.pairing.chat?.name ?? telegram.pairing.chat?.chatId ?? ""}
              control={
                <Button size="sm" variant="outline" disabled={busy}
                  onClick={() => void run(() => rubatoCompanion.unpairTelegram(environmentId))}>
                  Unpair
                </Button>
              }
            />
          ) : null}
          {telegram.waiting.map((message) => (
            <SettingsRow
              key={message.id}
              id={`rubato-companion-telegram-held-${message.id}`}
              title={`For ${HELD_KIND(message)}`}
              description={message.text}
              control={
                <span className="flex items-center gap-2">
                  <Button size="sm" disabled={busy}
                    onClick={() => void run(() => rubatoCompanion.decideTelegram(environmentId, message.id, "approve"))}>
                    Approve
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy}
                    onClick={() => void run(() => rubatoCompanion.decideTelegram(environmentId, message.id, "reject"))}>
                    Reject
                  </Button>
                </span>
              }
            />
          ))}
        </>
      ) : null}
    </SettingsSection>
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
      <TelegramPanel environmentId={environmentId} />
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
