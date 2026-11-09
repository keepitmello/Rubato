// The memory page, organised by whose memory it is: at a glance, me (what agents know about the
// person, shared and companion-only), projects (one file = one question's current answer, with how it
// changed), Segno (its status board, questions, records, people) and the dream (state per store and
// the model ladder). The server half is harness/t3-integration/src/memory/service.mjs.
import { BrainIcon, CalendarDaysIcon, FolderIcon, MoonIcon, SearchIcon, SparklesIcon, UserIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { uiLanguage, uiText } from "../../rubatoI18n";
import {
  rubatoMemory,
  type MemoryInsights,
  type MemorySearchHit,
  type MemoryStatus,
  type MemoryStoreSummary,
  type UserMemoryView,
  USER_STORE,
} from "../../state/rubatoMemory";
import { answerText, changeRequestText, rubatoSegnoMemory, useCompanionSender, type SegnoMemoryView } from "../../state/rubatoSegnoMemory";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { useReadyEnvironmentId } from "./RubatoMemorySettings";
import { DreamView } from "./RubatoMemoryDream";
import {
  changePhrases,
  fallbackTopics,
  insightLanguage,
  listedStores,
  meCounts,
  MEMORY_VIEWS,
  needsYou,
  openItems,
  placeCompanionLines,
  projectLine,
  type MemoryView,
  type NeedsYou,
} from "./RubatoMemoryPage.logic";
import { AnswerBox, ago, Dots, MemoryCard, MemoryRow, Muted, reportError, Tag, useDismissed, ViewHeading } from "./RubatoMemoryParts";
import { ProjectsView, type ProjectTarget } from "./RubatoMemoryProjects";
import { SegnoView, type SegnoTarget } from "./RubatoMemorySegno";
import { overlapKey, PersonalitySection, UserMemoryPanel } from "./RubatoUserMemory";
import { SettingsPageContainer } from "./settingsLayout";

type EnvironmentId = ReturnType<typeof useReadyEnvironmentId>;

const NAV: ReadonlyArray<{ readonly view: MemoryView; readonly label: string; readonly icon: typeof BrainIcon }> = [
  { view: "home", label: "At a glance", icon: SparklesIcon },
  { view: "me", label: "Me", icon: UserIcon },
  { view: "projects", label: "Projects", icon: FolderIcon },
  { view: "segno", label: "Segno", icon: CalendarDaysIcon },
  { view: "dream", label: "Dream", icon: MoonIcon },
];

// The view (and the project file or Segno record it opened) lives in the address, so a link or a
// reload lands on the same place: /memory?view=projects&store=rubato&file=decisions/x.md.
function readAddress(): { view: MemoryView; project: ProjectTarget | null; segno: SegnoTarget | null } {
  const params = new URLSearchParams(window.location.search);
  const view = MEMORY_VIEWS.find((entry) => entry === params.get("view")) ?? "home";
  const store = params.get("store");
  const file = params.get("file");
  const record = params.get("record");
  return {
    view,
    project: store ? { store, ...(file ? { file } : {}) } : null,
    segno: record ? { path: record } : null,
  };
}
function writeAddress(view: MemoryView, project: ProjectTarget | null, segno: SegnoTarget | null) {
  const params = new URLSearchParams(window.location.search);
  for (const key of ["view", "store", "file", "record"]) params.delete(key);
  if (view !== "home") params.set("view", view);
  if (view === "projects" && project) {
    params.set("store", project.store);
    if (project.file) params.set("file", project.file);
  }
  if (view === "segno" && segno) params.set("record", segno.path);
  const search = params.toString();
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
}

export interface MemoryPageData {
  readonly environmentId: EnvironmentId;
  readonly stores: readonly MemoryStoreSummary[] | null;
  readonly storesError: string | null;
  readonly memoryRoot: string | null;
  readonly status: MemoryStatus | null;
  readonly statusError: string | null;
  readonly user: UserMemoryView | null;
  readonly segno: SegnoMemoryView | null;
  readonly segnoError: string | null;
  readonly insights: MemoryInsights | null;
  readonly reloadStores: () => Promise<void>;
  readonly reloadStatus: () => Promise<void>;
  readonly reloadSegno: () => Promise<void>;
  readonly setStatus: (next: MemoryStatus | null) => void;
  readonly setStores: (next: MemoryStoreSummary[] | null) => void;
}

function useMemoryPageData(environmentId: EnvironmentId): MemoryPageData {
  const [stores, setStores] = useState<MemoryStoreSummary[] | null>(null);
  const [storesError, setStoresError] = useState<string | null>(null);
  const [memoryRoot, setMemoryRoot] = useState<string | null>(null);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [user, setUser] = useState<UserMemoryView | null>(null);
  const [segno, setSegno] = useState<SegnoMemoryView | null>(null);
  const [segnoError, setSegnoError] = useState<string | null>(null);
  const [insights, setInsights] = useState<MemoryInsights | null>(null);
  const language = insightLanguage(uiLanguage());

  const reloadStores = useCallback(async () => {
    if (environmentId === null) return;
    try {
      const next = await rubatoMemory.stores(environmentId);
      setStores(next.stores);
      setMemoryRoot(next.memoryRoot);
      setStoresError(null);
    } catch (error) {
      setStoresError(error instanceof Error ? error.message : String(error));
    }
  }, [environmentId]);
  const reloadStatus = useCallback(async () => {
    if (environmentId === null) return;
    try {
      setStatus(await rubatoMemory.status(environmentId));
      setStatusError(null);
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }, [environmentId]);
  const reloadSegno = useCallback(async () => {
    if (environmentId === null) return;
    try {
      setSegno(await rubatoSegnoMemory.memory(environmentId));
      setSegnoError(null);
    } catch (error) {
      setSegnoError(error instanceof Error ? error.message : String(error));
    }
  }, [environmentId]);
  const reloadInsights = useCallback(async () => {
    if (environmentId === null) return;
    try {
      setInsights(await rubatoMemory.insights(environmentId, language));
    } catch {
      // The page reads fine without them: counts and titles stand in.
    }
  }, [environmentId, language]);

  useEffect(() => {
    if (environmentId === null) return;
    void reloadStores();
    void reloadStatus();
    void reloadSegno();
    void reloadInsights();
    void rubatoMemory.userView(environmentId).then(setUser, () => undefined);
  }, [environmentId, reloadStores, reloadStatus, reloadSegno, reloadInsights]);

  // A model call writes the overlaps and the week's lines in the background; look again until it is done.
  const insightsWorking =
    insights !== null && (insights.projects.status === "working" || Object.values(insights.overlaps).some((entry) => entry.status === "working"));
  useEffect(() => {
    if (!insightsWorking) return;
    const timer = window.setTimeout(() => void reloadInsights(), 4_000);
    return () => window.clearTimeout(timer);
  }, [insightsWorking, insights, reloadInsights]);

  // A dream runs for minutes; while one is going, look again every 15 seconds.
  const dreaming = stores?.some((store) => store.running !== null) ?? false;
  useEffect(() => {
    if (!dreaming) return;
    const timer = window.setInterval(() => {
      void reloadStores();
      void reloadStatus();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [dreaming, reloadStores, reloadStatus]);

  return {
    environmentId, stores, storesError, memoryRoot, status, statusError, user, segno, segnoError, insights,
    reloadStores, reloadStatus, reloadSegno, setStatus, setStores,
  };
}

export function RubatoMemoryPage() {
  const environmentId = useReadyEnvironmentId();
  const initial = useMemo(readAddress, []);
  const [view, setView] = useState<MemoryView>(initial.view);
  const [project, setProject] = useState<ProjectTarget | null>(initial.project);
  const [segnoTarget, setSegnoTarget] = useState<SegnoTarget | null>(initial.segno);
  const [meHighlight, setMeHighlight] = useState<string | null>(null);
  const data = useMemoryPageData(environmentId);
  const { dismissed, dismiss } = useDismissed();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => writeAddress(view, project, segnoTarget), [view, project, segnoTarget]);
  const go = useCallback((next: MemoryView, target?: { project?: ProjectTarget | null; segno?: SegnoTarget | null; me?: string | null }) => {
    setView(next);
    if (target?.project !== undefined) setProject(target.project);
    if (target?.segno !== undefined) setSegnoTarget(target.segno);
    if (target?.me !== undefined) setMeHighlight(target.me);
    scrollRef.current?.querySelector("[data-settings-page-scroll]")?.scrollTo({ top: 0 });
  }, []);

  const segno = data.segno;
  const overlaps = segno ? (data.insights?.overlaps[segno.id]?.value?.pairs ?? []) : [];
  const listed = data.stores ? listedStores(data.stores) : null;
  const needs = needsYou({ segno, overlaps, user: data.user, stores: data.stores ?? [], dismissed });
  const counts = meCounts(data.user, segno);

  const navCount = (entry: MemoryView): ReactNode => {
    if (entry === "home") return needs.length > 0 ? <span className="rounded-full bg-amber-600 px-1.5 text-[11px] leading-5 text-white tabular-nums">{needs.length}</span> : null;
    if (entry === "me") return data.user ? <small className="text-xs text-muted-foreground tabular-nums">{segno ? `${counts.shared} + ${segno.title} ${counts.companion}` : counts.shared}</small> : null;
    if (entry === "projects") return listed ? <small className="text-xs text-muted-foreground tabular-nums">{`${listed.length} places`}</small> : null;
    if (entry === "segno") return segno ? <small className="text-xs text-muted-foreground tabular-nums">{`${openItems(segno)} open`}</small> : null;
    return null;
  };

  return (
    <div ref={scrollRef} className="flex min-h-0 min-w-0 flex-1">
      <nav aria-label="Memory" className="hidden w-52 shrink-0 flex-col gap-0.5 border-e border-border/60 bg-muted/20 px-2.5 py-4 md:flex">
        {NAV.map((entry, index) => (
          <div key={entry.view}>
            {index === 1 ? <p className="mx-2.5 mt-3 mb-1 text-[11px] text-muted-foreground">Whose memory</p> : null}
            {index === 4 ? <p className="mx-2.5 mt-3 mb-1 text-[11px] text-muted-foreground">Upkeep</p> : null}
            <button
              type="button"
              aria-current={view === entry.view ? "page" : undefined}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm",
                view === entry.view ? "bg-background font-medium shadow-xs" : "text-foreground/80 hover:bg-accent/50",
              )}
              onClick={() => go(entry.view, entry.view === "projects" ? { project: null } : entry.view === "segno" ? { segno: null } : undefined)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <entry.icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{entry.view === "segno" && segno ? segno.title : entry.label}</span>
              </span>
              {navCount(entry.view)}
            </button>
          </div>
        ))}
      </nav>
      <SettingsPageContainer width="wide" className="gap-5">
        <div className="flex gap-1 overflow-x-auto md:hidden" role="tablist" aria-label="Memory">
          {NAV.map((entry) => (
            <Button key={entry.view} size="xs" variant={view === entry.view ? "secondary" : "ghost"} onClick={() => go(entry.view)}>
              {entry.view === "segno" && segno ? segno.title : entry.label}
            </Button>
          ))}
        </div>
        {view === "home" ? (
          <GlanceView data={data} needs={needs} counts={counts} onGo={go} onDismiss={dismiss} />
        ) : view === "me" ? (
          <MeView data={data} highlight={meHighlight} dismissed={dismissed} onDismiss={dismiss} />
        ) : view === "projects" ? (
          <ProjectsView data={data} target={project} onTarget={(target) => setProject(target)} />
        ) : view === "segno" ? (
          <SegnoView data={data} target={segnoTarget} onTarget={setSegnoTarget} />
        ) : (
          <DreamView data={data} onOpenStore={(store) => go("projects", { project: { store } })} />
        )}
      </SettingsPageContainer>
    </div>
  );
}

// --- At a glance

function GlanceView({
  data,
  needs,
  counts,
  onGo,
  onDismiss,
}: {
  data: MemoryPageData;
  needs: readonly NeedsYou[];
  counts: ReturnType<typeof meCounts>;
  onGo: (view: MemoryView, target?: { project?: ProjectTarget | null; segno?: SegnoTarget | null; me?: string | null }) => void;
  onDismiss: (id: string) => void;
}) {
  const { segno, insights } = data;
  const listed = data.stores ? listedStores(data.stores) : null;
  const topStores = (listed ?? []).toSorted((a, b) => b.files - a.files).slice(0, 3);
  const projects = insights?.changes.projects ?? null;
  return (
    <>
      <ViewHeading title="At a glance" sub="What Rubato remembers, and what needs a look from you." />
      <GlanceSearch environmentId={data.environmentId} segnoTitle={segno?.title ?? "Segno"} onGo={onGo} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Tile onClick={() => onGo("me")} tag={<Tag tone="all">Every agent reads</Tag>} title={`Me · ${counts.shared + counts.companion}`}>
          <Dots
            parts={[
              ...counts.topics.map((topic) => ({ keep: `${topic.title ?? topic.id} ${topic.n}` })),
              segno && counts.companion > 0 ? `${segno.title} only ${counts.companion}` : null,
            ]}
          />
        </Tile>
        <Tile onClick={() => onGo("projects", { project: null })} tag={<Tag tone="decision">That project's lead reads</Tag>} title={listed ? `Projects · ${listed.length}` : "Projects"}>
          <Dots parts={topStores.map((store) => ({ keep: `${store.store} ${store.files}` }))} />
          {listed && listed.length > topStores.length ? " …" : ""}
        </Tile>
        <Tile
          onClick={() => onGo("segno", { segno: null })}
          tag={<Tag tone="companion">{segno ? `Only ${segno.title} reads` : "Only Segno reads"}</Tag>}
          title={segno ? `${segno.title} · ${openItems(segno)} open` : "Segno"}
        >
          {segno ? (
            <Dots
              parts={[
                `${segno.questions?.items.filter((item) => !item.proposal && !item.sent).length ?? 0} questions`,
                `${segno.records.length} days of records`,
                `${segno.entities.length} people and companies`,
              ]}
            />
          ) : (
            (data.segnoError ?? "")
          )}
        </Tile>
      </div>

      <NeedsYouCard data={data} needs={needs} onGo={onGo} onDismiss={onDismiss} />

      <MemoryCard title="Recently changed" aside={<span>{insights ? `Last ${insights.changes.days} days · by project` : ""}</span>}>
        {projects === null ? (
          <MemoryRow>
            <span className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-3.5" /> Loading
            </span>
          </MemoryRow>
        ) : projects.length === 0 ? (
          <MemoryRow>
            <span className="text-muted-foreground">Nothing changed this week.</span>
          </MemoryRow>
        ) : (
          projects.map((project) => {
            const line = projectLine(insights, project.store);
            const fallback = fallbackTopics(project);
            const phrases = changePhrases(project);
            return (
              <MemoryRow
                key={project.store}
                onClick={() => onGo("projects", { project: { store: project.store } })}
                actions={
                  <span className="text-xs whitespace-nowrap text-muted-foreground">
                    <Dots
                      parts={[
                        project.writers.dream > 0 ? `dream ${project.writers.dream}` : null,
                        project.writers.session > 0 ? `session ${project.writers.session}` : null,
                        project.writers.you > 0 ? `you ${project.writers.you}` : null,
                        ago(project.at),
                      ]}
                    />
                  </span>
                }
              >
                <div>
                  <b translate="no">{project.store}</b>
                  {phrases.map((entry) => (
                    <span key={entry.phrase}>
                      {" · "}
                      <span>{entry.phrase.replace("{0}", String(entry.n))}</span>
                    </span>
                  ))}
                </div>
                {line ? (
                  <Muted>
                    <span translate="no">{line}</span>
                  </Muted>
                ) : (
                  <Muted>
                    <span translate="no">{fallback.titles.join(" · ")}</span>
                    {fallback.more > 0 ? (
                      <>
                        {" · "}
                        <span>{`${fallback.more} more`}</span>
                      </>
                    ) : null}
                  </Muted>
                )}
              </MemoryRow>
            );
          })
        )}
        {insights?.projects.status === "working" && !projectLine(insights, projects?.[0]?.store ?? "") ? (
          <MemoryRow>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3" /> Writing a plain summary for each project…
            </span>
          </MemoryRow>
        ) : null}
      </MemoryCard>
    </>
  );
}

function Tile({ tag, title, children, onClick }: { tag: ReactNode; title: ReactNode; children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-xl border border-border/70 bg-card px-4 py-3 text-left hover:bg-accent/30">
      <div>{tag}</div>
      <div className="my-1 text-lg font-semibold">{title}</div>
      <div className="text-xs leading-relaxed text-muted-foreground">{children}</div>
    </button>
  );
}

function NeedsYouCard({
  data,
  needs,
  onGo,
  onDismiss,
}: {
  data: MemoryPageData;
  needs: readonly NeedsYou[];
  onGo: (view: MemoryView, target?: { project?: ProjectTarget | null; segno?: SegnoTarget | null; me?: string | null }) => void;
  onDismiss: (id: string) => void;
}) {
  const segnoTitle = data.segno?.title ?? "Segno";
  const sender = useCompanionSender(data.environmentId, data.segno?.id ?? "segno");
  const [answering, setAnswering] = useState<string | null>(null);
  const shown = needs.slice(0, 8);
  return (
    <MemoryCard title="Needs you" aside={<span>{`${needs.length} items`}</span>}>
      {needs.length === 0 ? (
        <MemoryRow>
          <span className="text-muted-foreground">Nothing waits for you.</span>
        </MemoryRow>
      ) : null}
      {shown.map((item) => {
        if (item.kind === "question")
          return (
            <MemoryRow
              key={item.id}
              actions={
                answering === item.id ? null : (
                  <Button size="xs" disabled={!sender.ready} title={sender.ready ? undefined : `${segnoTitle} is not in the app right now.`} onClick={() => setAnswering(item.id)}>
                    Answer
                  </Button>
                )
              }
            >
              <div className="flex items-start gap-2">
                <Tag tone="companion">{`${segnoTitle} asks`}</Tag>
                <div className="min-w-0 flex-1">
                  <span translate="no">{item.text}</span>
                  <Muted>
                    <span>{`${segnoTitle} · questions`}</span>
                    {item.refs ? <span translate="no">{` · ${item.refs}`}</span> : null}
                  </Muted>
                  {answering === item.id ? (
                    <AnswerBox
                      companion={segnoTitle}
                      onCancel={() => setAnswering(null)}
                      onSend={async (answer) => {
                        await sender.send(answerText(item.text, answer), item.id);
                        setAnswering(null);
                        toastManager.add({ type: "success", title: `Sent to ${segnoTitle}`, description: uiText(`${segnoTitle} reads it in its conversation.`) });
                        await data.reloadSegno();
                      }}
                    />
                  ) : null}
                </div>
              </div>
            </MemoryRow>
          );
        if (item.kind === "proposal")
          return (
            <MemoryRow key={item.id} actions={<Button size="xs" variant="outline" onClick={() => onGo("segno", { segno: null })}>View</Button>}>
              <div className="flex items-start gap-2">
                <Tag tone="attention">Proposal</Tag>
                <div className="min-w-0 flex-1">
                  <span translate="no">{item.text}</span>
                  <Muted>
                    <span>{`${segnoTitle} suggests a line for its prompt`}</span>
                    {item.refs ? <span translate="no">{` · ${item.refs}`}</span> : null}
                  </Muted>
                </div>
              </div>
            </MemoryRow>
          );
        if (item.kind === "overlap")
          return (
            <MemoryRow
              key={item.id}
              actions={
                <Button size="xs" variant="outline" onClick={() => onGo("me", { me: item.overlap.shared })}>
                  Compare
                </Button>
              }
            >
              <div className="flex items-start gap-2">
                <Tag tone="attention">{item.overlap.relation === "conflict" ? "Conflict" : "Overlap"}</Tag>
                <div className="min-w-0 flex-1">
                  <span>{`${segnoTitle} only:`}</span> <span translate="no">“{item.line}”</span>
                  <Muted>
                    <span>Every agent:</span> <span translate="no">“{item.shared}”</span>
                  </Muted>
                  {item.overlap.note ? (
                    <Muted>
                      <span translate="no">{item.overlap.note}</span>
                    </Muted>
                  ) : null}
                </div>
              </div>
            </MemoryRow>
          );
        if (item.kind === "dream-failed")
          return (
            <MemoryRow key={item.id} actions={<Button size="xs" variant="outline" onClick={() => onGo("dream")}>See why</Button>}>
              <div className="flex items-start gap-2">
                <Tag tone="attention">Dream failed</Tag>
                <div className="min-w-0 flex-1">
                  <span translate="no">{item.store}</span>
                  {item.reason ? (
                    <Muted>
                      <span translate="no">{item.reason.split("\n")[0]}</span>
                    </Muted>
                  ) : null}
                </div>
              </div>
            </MemoryRow>
          );
        return (
          <MemoryRow key={item.id} actions={<Button size="xs" variant="ghost" onClick={() => onDismiss(item.id)}>Got it</Button>}>
            <div className="flex items-start gap-2">
              <Tag tone="quiet">Empty</Tag>
              <div className="min-w-0 flex-1">
                <span translate="no">{item.stores.join(", ")}</span>
                <Muted>Opened by an agent but nothing was ever saved, so they are not listed as memory.</Muted>
              </div>
            </div>
          </MemoryRow>
        );
      })}
      {needs.length > shown.length ? (
        <MemoryRow onClick={() => onGo("segno", { segno: null })}>
          <span className="text-xs text-muted-foreground">{`${needs.length - shown.length} more`}</span>
        </MemoryRow>
      ) : null}
    </MemoryCard>
  );
}

/** One box over every project's memory, what is remembered about the person, and the companion's records. */
function GlanceSearch({
  environmentId,
  segnoTitle,
  onGo,
}: {
  environmentId: EnvironmentId;
  segnoTitle: string;
  onGo: (view: MemoryView, target?: { project?: ProjectTarget | null; segno?: SegnoTarget | null; me?: string | null }) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{
    query: string;
    hits: MemorySearchHit[];
    segno: ReadonlyArray<{ path: string; line: number; text: string }>;
  } | null>(null);
  const [searching, setSearching] = useState(false);
  const submit = async () => {
    const text = query.trim();
    if (text === "") return;
    setSearching(true);
    try {
      const [memory, segno] = await Promise.all([
        rubatoMemory.search(environmentId, text),
        rubatoSegnoMemory.search(environmentId, text).catch(() => ({ results: [], truncated: false })),
      ]);
      setResults({ query: text, hits: memory.results, segno: segno.results.slice(0, 8) });
    } catch (cause) {
      reportError("Could not search memory", cause);
    } finally {
      setSearching(false);
    }
  };
  return (
    <div className="space-y-2">
      <form
        className="relative"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <SearchIcon className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="ps-9"
          placeholder="Search all memory: a decision, a person's name, an error, a file…"
          value={query}
          aria-label="Search all memory"
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            if (event.currentTarget.value === "") setResults(null);
          }}
        />
        {searching ? <Spinner className="absolute end-3 top-1/2 size-4 -translate-y-1/2" /> : null}
      </form>
      {results ? (
        <MemoryCard>
          {results.hits.length === 0 && results.segno.length === 0 ? (
            <MemoryRow>
              <span className="text-muted-foreground">{`Nothing in memory matches "${results.query}"`}</span>
            </MemoryRow>
          ) : null}
          {results.hits.map((hit) => (
            <MemoryRow
              key={`${hit.store}/${hit.path}`}
              onClick={() =>
                hit.store === USER_STORE ? onGo("me", { me: hit.path }) : onGo("projects", { project: { store: hit.store, file: hit.path } })
              }
            >
              <div className="flex items-baseline gap-2">
                {hit.store === USER_STORE ? <Tag tone="all">Me</Tag> : <Tag tone="decision">{hit.store}</Tag>}
                <span translate="no" className="truncate">
                  {hit.description ?? hit.path}
                </span>
              </div>
              <Muted>
                <span translate="no">{hit.preview}</span>
              </Muted>
            </MemoryRow>
          ))}
          {results.segno.map((hit) => (
            <MemoryRow key={`segno:${hit.path}:${hit.line}`} onClick={() => onGo("segno", { segno: { path: hit.path } })}>
              <div className="flex items-baseline gap-2">
                <Tag tone="companion">{segnoTitle}</Tag>
                <span translate="no" className="truncate">
                  {hit.text}
                </span>
              </div>
              <Muted>
                <span translate="no">{hit.path}</span>
              </Muted>
            </MemoryRow>
          ))}
        </MemoryCard>
      ) : null}
    </div>
  );
}

// --- Me

function MeView({
  data,
  highlight,
  dismissed,
  onDismiss,
}: {
  data: MemoryPageData;
  highlight: string | null;
  dismissed: ReadonlySet<string>;
  onDismiss: (id: string) => void;
}) {
  const { segno } = data;
  const sender = useCompanionSender(data.environmentId, segno?.id ?? "segno");
  const overlapState = segno ? (data.insights?.overlaps[segno.id] ?? null) : null;
  const overlaps = overlapState?.value?.pairs ?? [];
  const sharedPaths = new Set((data.user?.topics ?? []).flatMap((topic) => topic.items.map((item) => item.path)));
  const lines = (segno?.about ?? []).filter((line) => line.kind === "user");
  const placed = placeCompanionLines(lines, overlaps, sharedPaths);
  return (
    <>
      <ViewHeading title="Me" sub="What agents know about you. Every line says who reads it." />
      <div className="flex flex-wrap gap-x-5 gap-y-1 px-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Tag tone="all">All agents</Tag>
          <span>Every lead, teammate and companion reads it</span>
        </span>
        {segno ? (
          <span className="flex items-center gap-1.5">
            <Tag tone="companion">{`${segno.title} only`}</Tag>
            <span>{`What ${segno.title} learned on its own; only ${segno.title} reads it`}</span>
          </span>
        ) : null}
        {overlapState?.status === "working" ? (
          <span className="flex items-center gap-1.5">
            <Spinner className="size-3" /> Checking where the two overlap…
          </span>
        ) : null}
      </div>
      <UserMemoryPanel
        environmentId={data.environmentId}
        highlight={highlight}
        companion={
          segno
            ? {
                id: segno.id,
                title: segno.title,
                placed,
                overlapStatus: overlapState?.status ?? null,
                canAsk: sender.ready,
                kept: dismissed,
                onKeep: (overlap) => onDismiss(overlapKey(overlap)),
                onAsk: async (line, request) => {
                  try {
                    await sender.send(changeRequestText(line.text, request), line.id);
                    toastManager.add({ type: "success", title: `Sent to ${segno.title}`, description: uiText(`${segno.title} changes its own notes when it reads it.`) });
                    await data.reloadSegno();
                    return true;
                  } catch (error) {
                    reportError(`Could not send to ${segno.title}`, error);
                    return false;
                  }
                },
              }
            : null
        }
        footer={<PersonalitySection environmentId={data.environmentId} />}
      />
    </>
  );
}
