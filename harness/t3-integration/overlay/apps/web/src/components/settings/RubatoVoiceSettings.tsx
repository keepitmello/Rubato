// Settings › Chat › Voice input: the OpenAI key and model the composer microphone
// transcribes with, and the token the iPhone Shortcut uses. The server half is
// the voice module's settings (harness/t3-integration/src/voice/settings.mjs); a
// save applies from the next recording, without restarting the app.
import { CheckIcon, CopyIcon, KeyRoundIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { rubatoVoiceSettings, type VoiceSettingsStatus } from "../../state/rubatoVoiceSettings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { useReadyEnvironmentId } from "./RubatoMemorySettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function reportError(title: string, error: unknown) {
  toastManager.add({ type: "error", title, description: error instanceof Error ? error.message : String(error) });
}

async function confirm(message: string): Promise<boolean> {
  const answer = requestConfirmDialog(message, { variant: "destructive" });
  return answer ? await answer : window.confirm(message);
}

function keyDescription(status: VoiceSettingsStatus): string {
  const { source, preview } = status.apiKey;
  if (source === "settings") return `Saved on this Mac: ${preview ?? "…"}. Only this Mac sends it, to OpenAI.`;
  if (source === "environment") return `Using OPENAI_API_KEY from the app's environment: ${preview ?? "…"}. A key saved here takes its place.`;
  return "Transcription needs an OpenAI API key. It stays on this Mac.";
}

export function RubatoVoiceSettingsSection() {
  const environmentId = useReadyEnvironmentId();
  const [status, setStatus] = useState<VoiceSettingsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingKey, setEditingKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (environmentId === null) return;
    try {
      const next = await rubatoVoiceSettings.status(environmentId);
      setStatus(next);
      setModelDraft(next.model ?? next.defaultModel);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [environmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (title: string, action: () => Promise<VoiceSettingsStatus>): Promise<boolean> => {
    setBusy(true);
    try {
      const next = await action();
      setStatus(next);
      setModelDraft(next.model ?? next.defaultModel);
      return true;
    } catch (cause) {
      reportError(title, cause);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async (event: FormEvent) => {
    event.preventDefault();
    const key = keyDraft.trim();
    if (!key) return;
    if (await run("Could not save the API key", () => rubatoVoiceSettings.saveApiKey(environmentId, key))) {
      setKeyDraft("");
      setEditingKey(false);
    }
  };

  const saveModel = () => {
    const model = modelDraft.trim();
    if (!status || model === "" || model === (status.model ?? status.defaultModel)) return;
    void run("Could not save the model", () => rubatoVoiceSettings.saveModel(environmentId, model));
  };

  const statusBadge = status?.ready ? (
    <Badge variant="success">Ready</Badge>
  ) : status?.apiKey.source === null ? (
    <Badge variant="outline">Needs an API key</Badge>
  ) : (
    <Badge variant="outline">Not set up</Badge>
  );

  return (
    <SettingsSection
      id="rubato-voice"
      title="Voice input"
      headerAction={
        <Button size="xs" variant="ghost" disabled={environmentId === null} onClick={() => void load()}>
          <RefreshCwIcon className="size-3.5" />
          Refresh
        </Button>
      }
    >
      {error ? <SettingsRow title="Could not read the voice settings" description={error} /> : null}
      {status === null && !error ? (
        <SettingsRow title="Reading the voice settings" control={<Spinner className="size-4" />} />
      ) : null}
      {status?.configError ? (
        <SettingsRow
          title="The voice settings file is broken"
          description={`${status.configPath} is not valid JSON. Fix or remove it, then refresh.`}
        />
      ) : null}
      {status ? (
        <>
          <SettingsRow
            id="rubato-voice-status"
            title="Dictation"
            description="The microphone beside the composer records on this Mac. OpenAI turns the recording into text at the cursor."
            status={statusBadge}
          />
          <SettingsRow
            id="rubato-voice-api-key"
            title="OpenAI API key"
            description={keyDescription(status)}
            control={
              editingKey ? null : (
                <div className="flex gap-2">
                  {status.apiKey.source === "settings" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        void (async () => {
                          if (!(await confirm("Remove the saved OpenAI API key from this Mac?"))) return;
                          await run("Could not remove the API key", () =>
                            rubatoVoiceSettings.saveApiKey(environmentId, null),
                          );
                        })();
                      }}
                    >
                      Remove
                    </Button>
                  ) : null}
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditingKey(true)}>
                    <KeyRoundIcon className="size-3.5" />
                    {status.apiKey.source === "settings" ? "Change key" : "Add key"}
                  </Button>
                </div>
              )
            }
          >
            {editingKey ? (
              <form className="mt-3 flex gap-2" onSubmit={(event) => void saveKey(event)}>
                <Input
                  autoFocus
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="sk-…"
                  aria-label="OpenAI API key"
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.currentTarget.value)}
                  className="flex-1"
                />
                <Button size="sm" type="submit" disabled={busy || !keyDraft.trim()}>
                  {busy ? <Spinner className="size-3.5" /> : null}
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    setKeyDraft("");
                    setEditingKey(false);
                  }}
                >
                  Cancel
                </Button>
              </form>
            ) : null}
          </SettingsRow>
          <SettingsRow
            id="rubato-voice-model"
            title="Transcription model"
            description={`OpenAI model id. Default: ${status.defaultModel}.`}
            control={
              <Input
                size="sm"
                font="mono"
                spellCheck={false}
                aria-label="Transcription model"
                value={modelDraft}
                disabled={busy}
                onChange={(event) => setModelDraft(event.currentTarget.value)}
                onBlur={saveModel}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                className="w-48"
              />
            }
          />
          {status.shortcutToken ? (
            <SettingsRow
              id="rubato-voice-shortcut-token"
              title="iPhone Shortcut token"
              description="The iPhone Shortcut sends recordings to this Mac with this token. A new token stops the old Shortcut."
              control={
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const token = status.shortcutToken;
                      if (!token) return;
                      void navigator.clipboard.writeText(token).then(() => {
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1500);
                      });
                    }}
                  >
                    {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      void (async () => {
                        if (!(await confirm("Make a new Shortcut token? The Shortcut with the old one stops working.")))
                          return;
                        await run("Could not rotate the token", () => rubatoVoiceSettings.rotateToken(environmentId));
                      })();
                    }}
                  >
                    New token
                  </Button>
                </div>
              }
            />
          ) : null}
        </>
      ) : null}
    </SettingsSection>
  );
}
