import { BookmarkCheckIcon, BookmarkIcon, CheckIcon, ChevronDownIcon, CircleAlertIcon } from "lucide-react";
import { useState } from "react";
import type { UserMemoryItem, UserMemoryView } from "../../state/rubatoMemory";
import { uiText } from "../../rubatoI18n";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type Rule = NonNullable<UserMemoryItem["rule"]> & { path: string; label: string };
const PREVIEW = 3;

export function SessionRules({ topics, save }: {
  topics: UserMemoryView["topics"];
  save: (rule: Rule, load: boolean) => Promise<void>;
}) {
  const [all, setAll] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rank = { changed: 0, on: 1, off: 2 };
  const rules = topics.flatMap((topic) => topic.items.flatMap((item): Rule[] =>
    item.rule ? [{ ...item.rule, path: item.path, label: item.summarized ? item.text : item.rule.description || item.text }] : [],
  )).sort((a, b) => rank[a.state] - rank[b.state]);
  const change = async (rule: Rule, load: boolean) => {
    setSaving(rule.path);
    setError(null);
    try { await save(rule, load); } catch { setError(rule.path); } finally { setSaving(null); }
  };
  const loaded = rules.filter((r) => r.state === "on").length;
  return (
    <SettingsSection id="memory-session-rules" title="Rules for new sessions">
      <SettingsRow
        title={<span className="inline-flex items-center gap-2"><BookmarkCheckIcon className="size-4 text-muted-foreground" />Choose what agents start with</span>}
        description="Rubato remembers automatically. Each rule you include takes up space in every new session. Open sessions stay as they are."
        status={rules.length > 0 ? <span className="tabular-nums">{uiText("Included")} · {loaded} / {rules.length}</span> : undefined}
      />
      {rules.length === 0 && <SettingsRow title="No rules to choose yet" description="When Rubato remembers a preference or a way you like to work, you can choose it here." />}
      {(all ? rules : rules.slice(0, PREVIEW)).map((rule) => {
        const changed = rule.state === "changed";
        const on = rule.state === "on";
        return <SettingsRow key={rule.path} data-rule-path={rule.path} className={changed ? "bg-warning/6" : undefined}
          title={<span translate="no" className="font-medium">{rule.label}</span>}
          description={<span className="flex flex-col items-start gap-1.5">
            {rule.description && rule.description !== rule.label && <span translate="no" className="border-s-2 border-border ps-2">{rule.description}</span>}
            {changed && <span className="inline-flex items-center gap-1 text-warning-foreground"><CircleAlertIcon className="size-3" />Changed since you chose it. Paused for review.</span>}
            {!rule.description && <span>No instruction to include yet.</span>}
            {error === rule.path && <span role="alert" className="text-destructive-foreground">Could not save. Check the current wording and try again.</span>}
          </span>}
          control={<span className="flex flex-wrap items-center justify-end gap-1">
            {on && <span className="inline-flex items-center gap-1 pe-1 text-xs text-success-foreground"><CheckIcon className="size-3" /><span>Included</span></span>}
            {(changed || on) && <Button size="xs" variant="ghost" disabled={saving !== null} onClick={() => void change(rule, false)}>Leave out</Button>}
            {!on && <Button size="xs" variant="outline"
              disabled={saving !== null || !rule.description} onClick={() => void change(rule, true)}>
              {saving === rule.path ? <Spinner className="size-3" /> : <BookmarkIcon className="size-3" />}
              <span>{changed ? "Use this version" : "Include"}</span>
            </Button>}
          </span>} />;
      })}
      {rules.length > PREVIEW && <div className="px-4 py-2"><Button size="xs" variant="ghost" aria-expanded={all} onClick={() => setAll(!all)}>
        <ChevronDownIcon className={all ? "size-3 rotate-180" : "size-3"} />{all ? "Show fewer rules" : "Show all rules"}
      </Button></div>}
    </SettingsSection>
  );
}
