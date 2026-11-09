// Dream: where each store stands now (on or off, the last run, what it read and changed, why it
// failed) and the model ladder. A run's own changes open on demand; there is no list of every run.
import { PlayIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { rubatoMemory, type DreamModel, type MemoryStoreSummary } from "../../state/rubatoMemory";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { listedStores } from "./RubatoMemoryPage.logic";
import type { MemoryPageData } from "./RubatoMemoryPage";
import { ago, Dots, MemoryCard, MemoryRow, Muted, reportError, shortStamp, ViewHeading } from "./RubatoMemoryParts";
import { DreamModelsEditor, RunView } from "./RubatoMemorySettings";

type Health = "ok" | "failed" | "off" | "running" | "never";

const DOT: Record<Health, string> = {
  ok: "bg-teal-600",
  failed: "bg-amber-600",
  off: "bg-muted-foreground/40",
  running: "bg-blue-500 animate-pulse",
  never: "bg-muted-foreground/30",
};

function healthOf(store: MemoryStoreSummary): Health {
  if (store.running) return "running";
  if (!store.enabled) return "off";
  if (!store.lastRun) return "never";
  return store.lastRun.status === "failed" ? "failed" : "ok";
}

export function DreamView({ data, onOpenStore }: { data: MemoryPageData; onOpenStore: (store: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const stores = data.stores ? listedStores(data.stores).toSorted((a, b) => Number(b.enabled) - Number(a.enabled) || a.store.localeCompare(b.store)) : null;

  const setModels = async (models: readonly DreamModel[]) => {
    const previous = data.status;
    if (previous) data.setStatus({ ...previous, models });
    try {
      await rubatoMemory.config(data.environmentId, {
        models: models.map((entry) => (entry.reasoning ? { model: entry.model, reasoning: entry.reasoning } : { model: entry.model })),
      });
    } catch (cause) {
      data.setStatus(previous);
      reportError("Could not save the setting", cause);
    }
  };
  const setEnabled = async (store: string, enabled: boolean) => {
    const previous = data.stores;
    data.setStores(previous?.map((entry) => (entry.store === store ? { ...entry, enabled } : entry)) ?? null);
    try {
      await rubatoMemory.config(data.environmentId, { store, enabled });
    } catch (cause) {
      data.setStores(previous ? [...previous] : null);
      reportError("Could not save the setting", cause);
    }
  };
  const runNow = async (store: string) => {
    try {
      await rubatoMemory.dream(data.environmentId, store);
      toastManager.add({ type: "info", title: `Dream started for ${store}`, description: "This can take several minutes." });
      await data.reloadStores();
    } catch (cause) {
      reportError("Could not start the dream", cause);
    }
  };
  const segno = data.segno;
  const segnoDream = segno?.dream ?? null;

  return (
    <>
      <ViewHeading title="Dream" sub="Once a day it reads the new sessions and tidies memory. This shows where each store stands now, not every run." />

      <MemoryCard title="Models" aside={<span>Tried from the top</span>}>
        {data.statusError ? (
          <MemoryRow>
            <span className="text-destructive-foreground">{data.statusError}</span>
          </MemoryRow>
        ) : data.status === null ? (
          <MemoryRow>
            <span className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-3.5" /> Reading the dream settings
            </span>
          </MemoryRow>
        ) : (
          <div className="px-1 pb-1">
            <DreamModelsEditor models={data.status.models} onChange={(models) => void setModels(models)} />
          </div>
        )}
      </MemoryCard>

      <MemoryCard title="Each store" aside={<span>Its last run</span>}>
        {stores === null ? (
          <MemoryRow>
            <span className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-3.5" /> Loading
            </span>
          </MemoryRow>
        ) : null}
        {stores?.map((store) => {
          const health = healthOf(store);
          const last = store.lastRun;
          const failed = health === "failed";
          const expanded = open === store.store;
          return (
            <div key={store.store}>
              <MemoryRow
                actions={
                  <>
                    {last?.landed && last.changed ? (
                      <Button size="xs" variant={expanded ? "secondary" : "ghost"} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : store.store)}>
                        What it changed
                      </Button>
                    ) : null}
                    {failed ? (
                      <Button size="xs" variant={expanded ? "secondary" : "ghost"} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : store.store)}>
                        Why
                      </Button>
                    ) : null}
                    <Button size="xs" variant="outline" disabled={store.running !== null} onClick={() => void runNow(store.store)}>
                      {store.running ? <Spinner className="size-3" /> : <PlayIcon className="size-3" />}
                      {store.running ? "Dreaming" : "Run now"}
                    </Button>
                    <Switch aria-label={`Daily dream for ${store.store}`} checked={store.enabled} onCheckedChange={(enabled) => void setEnabled(store.store, enabled)} />
                  </>
                }
              >
                <div className="flex items-start gap-2.5">
                  <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[health])} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <button type="button" className="font-semibold hover:underline" onClick={() => onOpenStore(store.store)}>
                      <span translate="no">{store.store}</span>
                    </button>
                    <span className="text-muted-foreground">
                      {" · "}
                      <span>{store.enabled ? "On" : "Off"}</span>
                    </span>
                    <Muted>
                      {store.running ? (
                        <span>{`Dreaming now${store.running.startedAt ? `, started ${ago(store.running.startedAt)}` : ""}`}</span>
                      ) : last ? (
                        <Dots
                          parts={[
                            { keep: shortStamp(last.finishedAt ?? last.startedAt) },
                            `Read ${last.sessions ?? 0} sessions`,
                            failed ? "Failed" : last.landed ? `Changed ${last.changed ?? 0} questions` : "Changed nothing",
                            last.model ? { keep: last.model } : null,
                          ]}
                        />
                      ) : (
                        <span>No dream has run here yet</span>
                      )}
                    </Muted>
                    {failed && last?.reason ? (
                      <Muted className="text-warning-foreground">
                        <span translate="no">{last.reason.split("\n")[0]}</span>
                      </Muted>
                    ) : null}
                  </div>
                </div>
              </MemoryRow>
              {expanded && last ? (
                <div className="px-4 pb-4 ps-9">
                  {failed ? (
                    <Attempts attempts={last.attempts} />
                  ) : (
                    <RunView environmentId={data.environmentId} store={store} runId={last.runId} onAsk={() => onOpenStore(store.store)} />
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
        {segno && segnoDream ? (
          <div>
            <MemoryRow
              actions={
                segnoDream.lastStatus === "failed" && segnoDream.attempts.length > 0 ? (
                  <Button size="xs" variant={open === "__companion" ? "secondary" : "ghost"} aria-expanded={open === "__companion"} onClick={() => setOpen(open === "__companion" ? null : "__companion")}>
                    Why
                  </Button>
                ) : undefined
              }
            >
              <div className="flex items-start gap-2.5">
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[segnoDream.lastStatus === "failed" ? "failed" : segnoDream.lastRunAt ? "ok" : "never"])} aria-hidden />
                <div className="min-w-0 flex-1">
                  <span className="font-semibold" translate="no">
                    {segno.title}
                  </span>
                  <span className="text-muted-foreground">
                    {" · "}
                    <span>Its own nightly dream</span>
                  </span>
                  <Muted>
                    {segnoDream.lastRunAt ? (
                      <Dots parts={[{ keep: shortStamp(segnoDream.lastRunAt) }, segnoDream.lastStatus === "failed" ? "Failed" : segnoDream.lastStatus ? { keep: segnoDream.lastStatus } : null]} />
                    ) : (
                      <span>No dream has run yet</span>
                    )}
                  </Muted>
                  {segnoDream.lastStatus === "failed" && segnoDream.reason ? (
                    <Muted className="text-warning-foreground">
                      <span translate="no">{segnoDream.reason}</span>
                    </Muted>
                  ) : null}
                </div>
              </div>
            </MemoryRow>
            {open === "__companion" ? (
              <div className="px-4 pb-4 ps-9">
                <Attempts attempts={segnoDream.attempts} />
              </div>
            ) : null}
          </div>
        ) : null}
      </MemoryCard>
    </>
  );
}

function Attempts({ attempts }: { attempts: ReadonlyArray<{ readonly model: string; readonly ok: boolean; readonly error?: string }> }) {
  if (attempts.length === 0) return <p className="text-xs text-muted-foreground">No model was tried.</p>;
  return (
    <div className="space-y-1 rounded-lg border border-border/60 px-3 py-2 text-xs">
      <p className="text-muted-foreground">Models tried, in order</p>
      <ol className="space-y-0.5">
        {attempts.map((attempt, index) => (
          // The same model can sit on the ladder once; position is still the clearer key.
          <li key={index} className="flex gap-2">
            <span className={cn("shrink-0 font-mono", attempt.ok ? "text-success-foreground" : "text-destructive-foreground")}>
              {attempt.ok ? "✓" : "✗"} {attempt.model}
            </span>
            {attempt.error ? (
              <span translate="no" className="min-w-0 break-words text-muted-foreground">
                {attempt.error}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
