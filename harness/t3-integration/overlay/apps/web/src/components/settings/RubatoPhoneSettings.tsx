import { CheckIcon, CopyIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import * as Option from "effect/Option";
import { useCallback, useEffect, useRef, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { readLocalApi } from "../../localApi";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { rubatoPhone, type PhoneStatus } from "../../state/rubatoPhone";
import { usePreparedConnection } from "../../state/session";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

type EnvironmentId = ReturnType<typeof usePrimaryEnvironmentId>;

/** The primary environment's id once its HTTP connection is ready; null until then. */
function useReadyEnvironmentId(): EnvironmentId {
  const environmentId = usePrimaryEnvironmentId();
  const prepared = usePreparedConnection(environmentId);
  return Option.isSome(prepared) ? environmentId : null;
}

function openLink(url: string) {
  const api = readLocalApi();
  if (api) void api.shell.openExternal(url).catch(() => window.open(url, "_blank", "noopener"));
  else window.open(url, "_blank", "noopener");
}

function reportError(title: string, error: unknown) {
  toastManager.add({ type: "error", title, description: error instanceof Error ? error.message : String(error) });
}

async function confirm(message: string): Promise<boolean> {
  const answer = requestConfirmDialog(message, { variant: "destructive" });
  return answer ? await answer : window.confirm(message);
}

export function RubatoPhoneSettingsPanel() {
  const environmentId = useReadyEnvironmentId();
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const openedCode = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (environmentId === null) return;
    try {
      setStatus(await rubatoPhone.status(environmentId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [environmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const phase = status?.login.phase ?? "idle";
  const waiting = phase === "code" || phase === "linking";
  // The sign-in finishes in a browser, so follow it until it settles.
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(timer);
  }, [waiting, load]);

  // Open the approval page once per code, as the provider sign-ins do.
  const login = status?.login;
  useEffect(() => {
    if (login?.phase !== "code" || openedCode.current === login.userCode) return;
    openedCode.current = login.userCode;
    openLink(login.verificationUri);
  }, [login]);

  const run = async (title: string, action: () => Promise<PhoneStatus>) => {
    setBusy(true);
    try {
      setStatus(await action());
    } catch (cause) {
      reportError(title, cause);
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.linked === true;
  return (
    <SettingsPageContainer>
      <SettingsSection
        id="rubato-phone"
        title="Phone"
        headerAction={
          <Button size="xs" variant="ghost" disabled={environmentId === null} onClick={() => void load()}>
            <RefreshCwIcon className="size-3.5" />
            Refresh
          </Button>
        }
      >
        {error ? <SettingsRow title="Could not read the phone connection" description={error} /> : null}
        {status === null && !error ? (
          <SettingsRow title="Reading the phone connection" control={<Spinner className="size-4" />} />
        ) : null}
        {status ? (
          <SettingsRow
            title="T3 account"
            description={
              connected
                ? `This Mac sends agent activity for ${status.account ?? "your T3 account"} to the T3 app on your phone.`
                : "Sign in with a T3 account so this Mac can send notifications to the T3 app on your phone."
            }
            status={
              connected ? <Badge variant="success">Connected</Badge> : <Badge variant="outline">Not connected</Badge>
            }
            control={
              connected ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    void (async () => {
                      if (!(await confirm("Disconnect this Mac? Your phone stops getting notifications from it.")))
                        return;
                      await run("Could not disconnect", () => rubatoPhone.disconnect(environmentId));
                    })();
                  }}
                >
                  Disconnect
                </Button>
              ) : waiting ? null : (
                <Button size="sm" disabled={busy || environmentId === null} onClick={() => void run("Could not connect", () => rubatoPhone.connect(environmentId))}>
                  {busy ? <Spinner className="size-3.5" /> : null}
                  Connect
                </Button>
              )
            }
          />
        ) : null}
        {login?.phase === "code" ? (
          <div className="space-y-3 px-4 py-4 sm:px-5">
            <p className="text-sm">Approve this code with your T3 account. Any browser works, including the phone's.</p>
            <div className="flex flex-wrap items-center gap-3">
              <code className="rounded-md bg-muted px-3 py-1.5 font-mono text-lg tracking-widest">{login.userCode}</code>
              <Button size="sm" onClick={() => openLink(login.verificationUri)}>
                <ExternalLinkIcon className="size-3.5" />
                Open approval page
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void navigator.clipboard.writeText(login.verificationUri).then(() => setCopied(true))}
              >
                {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                {copied ? "Copied" : "Copy link"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void run("Could not cancel", () => rubatoPhone.cancel(environmentId))}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
        {login?.phase === "linking" ? (
          <SettingsRow title="Linking this Mac to T3" control={<Spinner className="size-4" />} />
        ) : null}
        {login?.phase === "error" ? <SettingsRow title="Could not connect" description={login.message} /> : null}
        {status ? (
          <SettingsRow
            title="Notifications"
            description="Finished turns, approvals and questions show up on the phone, with the project and thread titles."
            control={
              <Switch
                aria-label="Send notifications to the phone"
                checked={connected && status.notifications}
                disabled={!connected || busy}
                onCheckedChange={(enabled) =>
                  void run("Could not change notifications", () => rubatoPhone.notifications(environmentId, enabled))
                }
              />
            }
          />
        ) : null}
      </SettingsSection>
      <SettingsSection id="rubato-phone-setup" title="On your phone">
        <SettingsRow
          title="1. Sign in to the T3 Code app"
          description={
            status?.account
              ? `Use the same account: ${status.account}.`
              : "Use the same T3 account you connect above."
          }
        />
        <SettingsRow title="2. Allow notifications" description="The app asks after you sign in. Settings › T3 Code › Notifications changes it later." />
        <SettingsRow
          title="3. Keep the Mac connection as it is"
          description="The account only carries notifications. The app still reaches this Mac over Tailscale."
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
