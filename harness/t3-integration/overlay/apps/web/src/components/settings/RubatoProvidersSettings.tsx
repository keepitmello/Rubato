import { useAtomValue } from "@effect/atom-react";
import type { ProviderInstanceId, ServerProviderModel } from "@t3tools/contracts";
import { CheckIcon, CopyIcon, ExternalLinkIcon, PinIcon, PinOffIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { usePrimarySettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import {
  rubatoAuth,
  type AuthStatus,
  type ConnectionState,
  type LoginJob,
  type LoginMethod,
  type ProviderAccount,
  type ProviderStatus,
} from "../../state/rubatoAuth";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { iconForProviderModel } from "../chat/providerIconUtils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

type EnvironmentId = ReturnType<typeof usePrimaryEnvironmentId>;

/** The Rubato driver's instance; its models carry `<provider>/<model>` slugs. */
const RUBATO_DRIVER = "rubato-pi";

// `rubato auth` names providers for the terminal; the page names what people pick.
const DISPLAY_NAME: Record<string, string> = {
  anthropic: "Claude",
  "openai-codex": "Codex",
  xai: "Grok",
  cursor: "Cursor",
  "b-ai": "DeepSeek",
  kiro: "Kiro",
  "google-antigravity": "Antigravity",
  opencode: "OpenCode",
};
const DISPLAY_ORDER = ["anthropic", "openai-codex", "xai", "cursor", "b-ai", "google-antigravity", "kiro", "opencode"];

const STATE_VIEW: Record<ConnectionState, { label: string; dot: string; badge: "success" | "warning" | "outline" }> = {
  connected: { label: "Connected", dot: "bg-success", badge: "success" },
  stale: { label: "Sign in again", dot: "bg-warning", badge: "warning" },
  blocked: { label: "Blocked · sign in again", dot: "bg-warning", badge: "warning" },
  absent: { label: "Not connected", dot: "bg-muted-foreground/40", badge: "outline" },
};

const TYPE_LABEL: Record<string, string> = {
  oauth: "OAuth",
  api_key: "API key",
  "setup-token": "Setup token",
};

const METHOD_LABEL: Record<LoginMethod, string> = {
  oauth: "Sign in with browser",
  api_key: "Add API key",
  "setup-token": "Paste setup-token",
};

function displayName(provider: Pick<ProviderStatus, "id" | "label">): string {
  return DISPLAY_NAME[provider.id] ?? provider.label;
}

function ProviderIcon({ id, className }: { id: string; className?: string }) {
  const Icon = iconForProviderModel(RUBATO_DRIVER as never, { slug: `${id}/_` });
  return Icon ? <Icon className={cn("size-4 shrink-0", className)} aria-hidden /> : null;
}

function reportError(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
}

async function confirm(message: string): Promise<boolean> {
  const answer = requestConfirmDialog(message, { variant: "destructive" });
  return answer ? await answer : window.confirm(message);
}

function openLink(url: string) {
  const api = readLocalApi();
  if (api) void api.shell.openExternal(url).catch(() => window.open(url, "_blank", "noopener"));
  else window.open(url, "_blank", "noopener");
}

/** The primary environment's id once its HTTP connection is ready; null until then. */
function useReadyEnvironmentId(): EnvironmentId {
  const environmentId = usePrimaryEnvironmentId();
  const prepared = usePreparedConnection(environmentId);
  return Option.isSome(prepared) ? environmentId : null;
}

function summary(provider: ProviderStatus): string {
  const parts = [STATE_VIEW[provider.state].label];
  if (provider.accounts.length > 1) parts.push(`${provider.accounts.length} accounts`);
  return parts.join(" · ");
}

export function RubatoProvidersSettingsPanel() {
  const environmentId = useReadyEnvironmentId();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string>(DISPLAY_ORDER[0]!);
  const loadingRef = useRef(false);
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });

  const loadStatus = useCallback(async () => {
    if (environmentId === null || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      setStatus(await rubatoAuth.status(environmentId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [environmentId]);

  // A new or removed account changes which models the Rubato catalogue offers.
  const refreshModels = useCallback(() => {
    if (environmentId === null) return;
    void refreshServerProviders({ environmentId, input: { refreshModels: true } });
  }, [environmentId, refreshServerProviders]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const providers = useMemo(() => {
    const list = status?.providers ?? [];
    const rank = (id: string) => {
      const index = DISPLAY_ORDER.indexOf(id);
      return index < 0 ? DISPLAY_ORDER.length : index;
    };
    return list.toSorted((a, b) => rank(a.id) - rank(b.id));
  }, [status]);
  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="rubato-providers"
        title="Providers"
        variant="plain"
        headerAction={
          <Button
            size="xs"
            variant="ghost"
            disabled={loading || environmentId === null}
            onClick={() => {
              void loadStatus();
              refreshModels();
            }}
          >
            {loading ? <Spinner className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
            Refresh
          </Button>
        }
      >
        {error ? (
          <SettingsGroup>
            <SettingsRow title="Could not read provider accounts" description={error} />
          </SettingsGroup>
        ) : null}
        {status === null && !error ? (
          <SettingsGroup>
            <SettingsRow title="Reading provider accounts" control={<Spinner className="size-4" />} />
          </SettingsGroup>
        ) : null}
        {selected ? (
          <SettingsGroup divided={false} className="overflow-hidden md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
            <nav
              aria-label="Providers"
              className="divide-y divide-border/50 border-b border-border/60 bg-muted/10 md:border-r md:border-b-0"
            >
              {providers.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => setSelectedId(provider.id)}
                  aria-current={provider.id === selected.id ? "true" : undefined}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40",
                    provider.id === selected.id && "bg-accent/60",
                  )}
                >
                  <ProviderIcon id={provider.id} className="size-5" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{displayName(provider)}</span>
                    <span className="block truncate text-xs text-muted-foreground">{summary(provider)}</span>
                  </span>
                  <span className={cn("size-2 shrink-0 rounded-full", STATE_VIEW[provider.state].dot)} aria-hidden />
                </button>
              ))}
            </nav>
            <ProviderDetail
              key={selected.id}
              environmentId={environmentId}
              provider={selected}
              setupToken={status?.setupToken ?? null}
              onChanged={() => {
                void loadStatus();
                refreshModels();
              }}
            />
          </SettingsGroup>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function ProviderDetail({
  environmentId,
  provider,
  setupToken,
  onChanged,
}: {
  environmentId: EnvironmentId;
  provider: ProviderStatus;
  setupToken: AuthStatus["setupToken"] | null;
  onChanged: () => void;
}) {
  const [job, setJob] = useState<LoginJob | null>(null);
  const name = displayName(provider);

  const start = async (method: LoginMethod) => {
    try {
      setJob(await rubatoAuth.login(environmentId, provider.id, method));
    } catch (error) {
      reportError(`Could not start ${name} sign-in`, error);
    }
  };

  return (
    <div className="min-w-0 space-y-6 p-4">
      <div className="flex items-center gap-3">
        <ProviderIcon id={provider.id} className="size-6" />
        <h3 className="flex-1 text-base font-medium">{name}</h3>
        <Badge variant={STATE_VIEW[provider.state].badge}>{STATE_VIEW[provider.state].label}</Badge>
      </div>

      <div className="space-y-2">
        <h4 className="px-1 text-sm text-foreground/70">Accounts</h4>
        <SettingsGroup>
          {provider.accounts.length === 0 ? (
            <SettingsRow title="No account yet" description={`Connect ${name} below to use its models in Rubato.`} />
          ) : (
            provider.accounts.map((account) => (
              <AccountRow
                key={account.name}
                environmentId={environmentId}
                provider={provider}
                account={account}
                onChanged={onChanged}
              />
            ))
          )}
        </SettingsGroup>
        {provider.accounts.length > 1 ? (
          <p className="px-1 text-xs text-muted-foreground">
            Rubato rotates between accounts when one hits its limit. Pin one to use only that account.
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <h4 className="px-1 text-sm text-foreground/70">Connect</h4>
        {job ? (
          <LoginFlow
            environmentId={environmentId}
            job={job}
            onJob={setJob}
            onFinished={(finished) => {
              if (finished.status === "done") {
                toastManager.add({ type: "success", title: `${name} connected`, description: finished.message ?? undefined });
                setJob(null);
                onChanged();
              }
            }}
            onClose={() => setJob(null)}
          />
        ) : (
          <SettingsGroup>
            <div className="flex flex-wrap gap-2 p-4">
              {provider.methods.map((method) => (
                <Button key={method} size="sm" variant={method === provider.methods[0] ? "default" : "outline"} onClick={() => void start(method)}>
                  {METHOD_LABEL[method]}
                </Button>
              ))}
            </div>
            {provider.id === "anthropic" ? (
              <p className="px-4 py-3 text-xs leading-relaxed text-muted-foreground">
                Browser sign-in keeps an OAuth account that renews itself. A setup-token is a one-year token from{" "}
                <code className="rounded bg-muted px-1">claude setup-token</code>
                {setupToken ? (
                  <>
                    {" "}and is saved to <code className="rounded bg-muted px-1">{setupToken.path}</code>, not to auth.json
                  </>
                ) : null}
                . Both can be connected at once.
              </p>
            ) : null}
          </SettingsGroup>
        )}
      </div>

      <ProviderModels providerId={provider.id} name={name} />
    </div>
  );
}

function AccountRow({
  environmentId,
  provider,
  account,
  onChanged,
}: {
  environmentId: EnvironmentId;
  provider: ProviderStatus;
  account: ProviderAccount;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<"check" | "pin" | "remove" | null>(null);
  const state = STATE_VIEW[account.state];

  const run = async (kind: "check" | "pin" | "remove", work: () => Promise<void>) => {
    setBusy(kind);
    try {
      await work();
    } finally {
      setBusy(null);
    }
  };

  const check = () =>
    run("check", async () => {
      try {
        const result = await rubatoAuth.check(environmentId, provider.id, account.name);
        toastManager.add({
          type: result.kind === "ok" ? "success" : result.kind === "unsupported" ? "info" : "warning",
          title: `${account.name}: ${result.kind === "ok" ? "working" : result.kind === "unsupported" ? "no way to check ahead" : "needs attention"}`,
          description: result.message,
        });
        onChanged();
      } catch (error) {
        reportError("Could not check the account", error);
      }
    });

  const pin = () =>
    run("pin", async () => {
      try {
        await rubatoAuth.pin(environmentId, provider.id, account.pinned ? null : account.name);
        onChanged();
      } catch (error) {
        reportError("Could not change the pinned account", error);
      }
    });

  const remove = () =>
    run("remove", async () => {
      if (!(await confirm(`Remove the ${displayName(provider)} account '${account.name}'? You will need to sign in again to use it.`))) return;
      try {
        await rubatoAuth.remove(environmentId, provider.id, account.name);
        onChanged();
      } catch (error) {
        reportError("Could not remove the account", error);
      }
    });

  return (
    <SettingsRow
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          {account.name}
          {account.type ? <Badge variant="outline">{TYPE_LABEL[account.type] ?? account.type}</Badge> : null}
          {account.pinned ? <Badge variant="info">Pinned</Badge> : null}
        </span>
      }
      description={
        <span className="inline-flex items-center gap-1.5">
          <span className={cn("size-1.5 rounded-full", state.dot)} aria-hidden />
          {state.label}
          {account.source === "setup-token" ? " · replace it by pasting a new token" : null}
          {account.source === "env" ? " · from an environment variable" : null}
        </span>
      }
      control={
        <div className="flex items-center gap-1">
          <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void check()}>
            {busy === "check" ? <Spinner className="size-3.5" /> : <CheckIcon className="size-3.5" />}
            Check
          </Button>
          {provider.accounts.length > 1 ? (
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={busy !== null}
              aria-label={account.pinned ? "Unpin account" : "Use only this account"}
              title={account.pinned ? "Unpin account" : "Use only this account"}
              onClick={() => void pin()}
            >
              {account.pinned ? <PinOffIcon /> : <PinIcon />}
            </Button>
          ) : null}
          {account.removable ? (
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={busy !== null}
              aria-label="Remove account"
              title="Remove account"
              onClick={() => void remove()}
            >
              <Trash2Icon />
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

function LoginFlow({
  environmentId,
  job,
  onJob,
  onFinished,
  onClose,
}: {
  environmentId: EnvironmentId;
  job: LoginJob;
  onJob: (job: LoginJob) => void;
  onFinished: (job: LoginJob) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const openedUrl = useRef<string | null>(null);
  const running = job.status === "running";
  const promptId = job.prompt?.id ?? null;

  // Poll while the CLI works; a login waits on the browser for as long as the person takes.
  useEffect(() => {
    if (!running) {
      onFinished(job);
      return;
    }
    const timer = window.setInterval(() => {
      rubatoAuth.loginState(environmentId, job.id).then(onJob, (error: unknown) => {
        window.clearInterval(timer);
        reportError("Lost track of the sign-in", error);
        onClose();
      });
    }, 800);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, job.id, environmentId]);

  // The terminal login opens the browser by itself; so does this one, once per URL.
  useEffect(() => {
    const url = job.authUrl?.url ?? job.deviceCode?.verificationUri;
    if (!url || openedUrl.current === url) return;
    openedUrl.current = url;
    openLink(url);
  }, [job.authUrl?.url, job.deviceCode?.verificationUri]);

  useEffect(() => setValue(""), [promptId]);

  const answer = async (reply: string) => {
    if (promptId === null) return;
    setSending(true);
    try {
      onJob(await rubatoAuth.answer(environmentId, job.id, promptId, reply));
    } catch (error) {
      reportError("Could not send the answer", error);
    } finally {
      setSending(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) void answer(value);
  };
  const cancel = async () => {
    try {
      onJob(await rubatoAuth.cancel(environmentId, job.id));
    } catch {
      onClose();
    }
  };

  const prompt = job.prompt;
  return (
    <SettingsGroup>
      <div className="space-y-4 p-4">
        {job.authUrl ? (
          <div className="space-y-2">
            <p className="text-sm">{job.authUrl.instructions ?? "Finish signing in in your browser."}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => openLink(job.authUrl!.url)}>
                <ExternalLinkIcon className="size-3.5" />
                Open sign-in page
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(job.authUrl!.url).then(() => setCopied(true));
                }}
              >
                {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                {copied ? "Copied" : "Copy link"}
              </Button>
            </div>
          </div>
        ) : null}

        {job.deviceCode ? (
          <div className="space-y-2">
            <p className="text-sm">Enter this code on the verification page:</p>
            <div className="flex flex-wrap items-center gap-3">
              <code className="rounded-md bg-muted px-3 py-1.5 font-mono text-lg tracking-widest">{job.deviceCode.userCode}</code>
              <Button size="sm" variant="outline" onClick={() => openLink(job.deviceCode!.verificationUri)}>
                <ExternalLinkIcon className="size-3.5" />
                Open verification page
              </Button>
            </div>
          </div>
        ) : null}

        {prompt && running ? (
          prompt.kind === "select" && prompt.options ? (
            <div className="space-y-2">
              <p className="text-sm">{prompt.message}</p>
              <div className="flex flex-wrap gap-2">
                {prompt.options.map((option, index) => (
                  <Button
                    key={option.id}
                    size="sm"
                    variant={index === 0 ? "default" : "outline"}
                    disabled={sending}
                    onClick={() => void answer(option.id)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <form className="space-y-2" onSubmit={submit}>
              <p className="whitespace-pre-line text-sm text-muted-foreground">
                {prompt.kind === "manual_code"
                  ? "If the browser is on another device, paste the code or the final redirect URL here."
                  : prompt.message}
              </p>
              <div className="flex gap-2">
                <Input
                  autoFocus={prompt.kind !== "manual_code"}
                  type={prompt.kind === "secret" ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={prompt.placeholder ?? undefined}
                  value={value}
                  onChange={(event) => setValue(event.currentTarget.value)}
                  className="flex-1"
                />
                <Button size="sm" type="submit" disabled={sending || !value.trim()}>
                  {prompt.kind === "secret" ? "Save" : "Submit"}
                </Button>
              </div>
            </form>
          )
        ) : null}

        {running && !prompt && !job.authUrl && !job.deviceCode ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-3.5" /> Starting…
          </p>
        ) : null}
        {job.info.length > 0 && running ? (
          <p className="text-xs text-muted-foreground">{job.info.at(-1)}</p>
        ) : null}

        {!running && job.status !== "done" ? (
          <p className={cn("text-sm", job.status === "error" ? "text-destructive" : "text-muted-foreground")}>
            {job.status === "cancelled" ? "Sign-in cancelled." : (job.message ?? "Sign-in failed.")}
          </p>
        ) : null}

        <div className="flex justify-end">
          {running ? (
            <Button size="sm" variant="ghost" onClick={() => void cancel()}>
              Cancel
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </div>
    </SettingsGroup>
  );
}

/** The provider's models in the Rubato picker, with the one T3 setting worth keeping: visibility. */
function ProviderModels({ providerId, name }: { providerId: string; name: string }) {
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const settings = usePrimarySettings();
  const updateClientSettings = useUpdateClientSettings();
  const rubato = serverProviders.find((provider) => provider.driver === RUBATO_DRIVER);
  const models = (rubato?.models ?? []).filter((model: ServerProviderModel) => model.slug.startsWith(`${providerId}/`));
  if (!rubato) return null;
  const instanceId = rubato.instanceId as ProviderInstanceId;
  const preferences = settings.providerModelPreferences?.[instanceId] ?? { hiddenModels: [], modelOrder: [] };
  const hidden = new Set(preferences.hiddenModels);

  const setShown = (slug: string, shown: boolean) => {
    const next = new Set(hidden);
    if (shown) next.delete(slug);
    else next.add(slug);
    updateClientSettings({
      providerModelPreferences: {
        ...settings.providerModelPreferences,
        [instanceId]: { hiddenModels: [...next], modelOrder: [...preferences.modelOrder] },
      },
    });
  };

  return (
    <div className="space-y-2">
      <h4 className="px-1 text-sm text-foreground/70">Models in the picker</h4>
      <SettingsGroup>
        {models.length === 0 ? (
          <SettingsRow
            title="No models listed"
            description={`${name} models appear here once an account is connected and the list is refreshed.`}
          />
        ) : (
          models.map((model: ServerProviderModel) => (
            <SettingsRow
              key={model.slug}
              title={model.name}
              description={<code className="text-xs">{model.slug}</code>}
              control={
                <Switch
                  checked={!hidden.has(model.slug)}
                  onCheckedChange={(checked) => setShown(model.slug, Boolean(checked))}
                  aria-label={`Show ${model.name} in the model picker`}
                />
              }
            />
          ))
        )}
      </SettingsGroup>
    </div>
  );
}
