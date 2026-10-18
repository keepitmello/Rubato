import type { RubatoSessionAccount } from "../../state/rubatoSessionState";
import { rubatoAccountLabel } from "../../rubatoAccountLabel";

/** The actual first assignment, not a guess from the model currently selected in the picker. */
export function RubatoSessionAccountBadge({
  account,
  model,
}: {
  account?: RubatoSessionAccount | null | undefined;
  model: string;
}) {
  if (!account || !model.startsWith(`${account.provider}/`)) return null;
  const label = rubatoAccountLabel(account.modelSuffix) ?? account.name;
  return (
    <span
      data-rubato-session-account={account.name}
      className="inline-flex max-w-40 shrink-0 items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-xs text-muted-foreground"
      title={`${account.name} · Fixed for this session`}
    >
      <span className="truncate">{label}</span>
      {account.modelSuffix ? <span className="shrink-0 font-mono">[{account.modelSuffix.slice(1)}]</span> : null}
    </span>
  );
}
