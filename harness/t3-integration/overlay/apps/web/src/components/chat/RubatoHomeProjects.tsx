// The bottom of the home (new-thread) screen: one row of project tabs and the
// selected project's six newest threads, inside the composer's width and
// without a box. The composer stays where T3 centers it; this sits along the
// bottom, and only a window too short for both lifts the composer, by just
// enough to clear the row.
//
// The tabs are the shared project list the rail shows (rubatoProjectList.ts).
// A tab click changes the draft's project the way the headline's project
// picker does (DraftHeroHeadline.selectProject): an empty draft opens that
// project's own draft, a draft with a prompt keeps the prompt and moves. The
// row never wraps: ‹ › page through it, and › carries a dot while a project
// past the edge needs the user. + offers the projects taken off the list,
// hovering a tab shows − to take it off, and tabs reorder by drag.
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { scopeProjectRef, scopedProjectKey } from "@t3tools/client-runtime/environment";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { ChevronLeftIcon, ChevronRightIcon, MinusIcon, PlusIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import type { DraftId } from "~/composerDraftStore";
import { composerDraftHasUserContent, useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { hasExplicitComposerModelSelection } from "~/lib/chatThreadActions";
import { useClientSettings } from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { buildSidebarProjectPickerEntries, type SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import { useProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useUiStateStore } from "~/uiStateStore";
import { RubatoThreadLine } from "../sidebar/RubatoThreadLine";
import { useRubatoProjectList } from "../sidebar/rubatoProjectList";
import { useSectionScaleFactor } from "../sidebar/RubatoSectionScale";
import {
  anyNeedsUser,
  resolveThreadSignal,
  selectHomeThreads,
  threadKeyOf,
  urgentSignal,
  RUBATO_SIGNAL_DOT,
  RUBATO_SIGNAL_LABEL,
  type RubatoSignal,
} from "../sidebar/rubatoProjectRail.logic";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// Space kept between the composer stack and the row when the window is short.
const LIFT_GAP_PX = 24;

/** The headline picker's project change, for a tab click. */
function useSelectDraftProject(draftId: DraftId | null) {
  const { environments } = useEnvironments();
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const applyStickyState = useComposerDraftStore((store) => store.applyStickyState);
  const setModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const openProjectDraft = useNewThreadHandler();
  return useCallback(
    (project: ReturnType<typeof useProjects>[number], logicalProjectKey: string) => {
      if (!draftId) return;
      const currentDraft = getComposerDraft(draftId);
      if (!composerDraftHasUserContent(currentDraft)) {
        void openProjectDraft(scopeProjectRef(project.environmentId, project.id));
        return;
      }
      setLogicalProjectDraftThreadId(
        logicalProjectKey,
        scopeProjectRef(project.environmentId, project.id),
        draftId,
      );
      if (!hasExplicitComposerModelSelection(currentDraft)) {
        applyStickyState(draftId);
        const environmentSettings = environments.find(
          (environment) => environment.environmentId === project.environmentId,
        )?.serverConfig?.settings;
        const defaultModelSelection = environmentSettings
          ? resolveProjectSettings(environmentSettings, project.id, project).settings
              .defaultModelSelection
          : project.defaultModelSelection;
        if (defaultModelSelection) {
          setModelSelection(draftId, defaultModelSelection, { replaceOptions: true });
        }
      }
    },
    [
      applyStickyState,
      draftId,
      environments,
      getComposerDraft,
      openProjectDraft,
      setLogicalProjectDraftThreadId,
      setModelSelection,
    ],
  );
}

function ProjectTab(props: {
  group: SidebarProjectSnapshot;
  selected: boolean;
  signal: RubatoSignal | null;
  /** The row's section scale: dnd-kit's offsets are window pixels, the tab moves in zoomed ones. */
  zoom: number;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const sortable = useSortable({ id: props.group.projectKey });
  const offset = sortable.transform;
  return (
    <div
      ref={sortable.setNodeRef}
      data-rubato-home-tab={props.group.projectKey}
      className="group/tab relative shrink-0"
      style={{
        transform: CSS.Translate.toString(
          offset && { ...offset, x: offset.x / props.zoom, y: offset.y / props.zoom },
        ),
        transition: sortable.transition,
        zIndex: sortable.isDragging ? 1 : undefined,
      }}
    >
      <button
        {...sortable.attributes}
        {...sortable.listeners}
        type="button"
        aria-pressed={props.selected}
        onClick={props.onSelect}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-[7px] px-2.5 text-sm whitespace-nowrap outline-hidden",
          "focus-visible:ring-2 focus-visible:ring-ring",
          props.selected
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          sortable.isDragging && "cursor-grabbing",
        )}
      >
        <span>{props.group.displayName}</span>
        {props.signal ? (
          <span
            aria-label={RUBATO_SIGNAL_LABEL[props.signal]}
            className={cn("size-1.5 shrink-0 rounded-full", RUBATO_SIGNAL_DOT[props.signal])}
          />
        ) : null}
      </button>
      <button
        type="button"
        aria-label={`Remove ${props.group.displayName} from the list`}
        onClick={(event) => {
          event.stopPropagation();
          props.onRemove();
        }}
        className={cn(
          "absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full",
          "bg-muted-foreground text-background opacity-0 shadow-sm outline-hidden transition-opacity duration-100",
          "group-hover/tab:opacity-100 focus-visible:opacity-100",
          sortable.isDragging && "hidden",
        )}
      >
        <MinusIcon className="size-3" strokeWidth={2.5} />
      </button>
    </div>
  );
}

function RowButton(props: {
  label: string;
  disabled?: boolean;
  dot?: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
            className={cn(
              "relative flex size-8 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground outline-hidden",
              "hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:pointer-events-none disabled:opacity-35",
            )}
          >
            {props.children}
            {props.dot ? (
              <span aria-hidden="true" className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-warning" />
            ) : null}
          </button>
        }
      />
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** Off until Settings > Threads & Projects turns it on (RubatoHomeProjectsSetting.tsx). */
export function RubatoHomeProjects(props: Parameters<typeof RubatoHomeProjectsRow>[0]) {
  const visible = useClientSettings((settings) => settings.rubatoHomeProjects);
  return visible ? <RubatoHomeProjectsRow {...props} /> : null;
}

function RubatoHomeProjectsRow(props: {
  draftId: DraftId | null;
  activeProjectRef: ScopedProjectRef | null;
}) {
  const { isMobile } = useSidebar();
  const { groups, threads, list, signals, remove, add, move } = useRubatoProjectList();
  const tabsZoom = useSectionScaleFactor("homeTabs");
  const projects = useProjects();
  const localLastVisitedAt = useUiStateStore((store) => store.threadLastVisitedAtById);
  const selectProject = useSelectDraftProject(props.draftId);

  const activeGroup = useMemo(() => {
    const active = props.activeProjectRef;
    if (active === null) return null;
    return (
      groups.find((group) =>
        group.memberProjectRefs.some((ref) => scopedProjectKey(ref) === scopedProjectKey(active)),
      ) ?? null
    );
  }, [groups, props.activeProjectRef]);
  const pickerEntries = useMemo(
    () => buildSidebarProjectPickerEntries({ groups, preferredProjectRef: props.activeProjectRef }),
    [groups, props.activeProjectRef],
  );
  const projectByMember = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const)),
    [projects],
  );
  const homeThreads = useMemo(
    () => selectHomeThreads({ threads, group: activeGroup }),
    [activeGroup, threads],
  );

  // Paging: the row scrolls sideways, the arrows move it by most of a view.
  const viewportRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false, hiddenRightNeedsUser: false });
  const readEdges = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const left = viewport.scrollLeft > 1;
    const right = viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1;
    const viewEnd = viewport.scrollLeft + viewport.clientWidth;
    const hidden: (RubatoSignal | null)[] = [];
    for (const tab of viewport.querySelectorAll<HTMLElement>("[data-rubato-home-tab]")) {
      if (tab.offsetLeft + tab.offsetWidth > viewEnd + 1) {
        hidden.push(signals.get(tab.dataset.rubatoHomeTab ?? "") ?? null);
      }
    }
    setEdges({ left, right, hiddenRightNeedsUser: anyNeedsUser(hidden) });
  }, [signals]);
  useLayoutEffect(() => {
    readEdges();
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(readEdges);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [readEdges, list.listed]);
  // Keep the selected tab in view when the selection or the order changes.
  useEffect(() => {
    if (!activeGroup) return;
    viewportRef.current
      ?.querySelector<HTMLElement>(`[data-rubato-home-tab="${globalThis.CSS.escape(activeGroup.projectKey)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeGroup, list.listed]);
  const page = (direction: 1 | -1) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollBy({ left: direction * viewport.clientWidth * 0.8, behavior: "smooth" });
  };

  // A short window: lift the centered composer only as far as the row needs.
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const overlay = root?.parentElement;
    const stack = overlay?.querySelector<HTMLElement>('[data-chat-composer-stack="true"]');
    if (!root || !overlay || !stack) return;
    const update = () => {
      overlay.style.paddingBottom = "";
      const below = overlay.clientHeight / 2 - stack.offsetHeight / 2;
      const needed = root.offsetHeight + LIFT_GAP_PX;
      const lift = Math.max(0, needed - below);
      overlay.style.paddingBottom = lift > 0 ? `${Math.round(lift * 2)}px` : "";
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(overlay);
    observer.observe(stack);
    observer.observe(root);
    return () => {
      observer.disconnect();
      overlay.style.paddingBottom = "";
    };
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onDragEnd = (event: DragEndEvent) => {
    if (event.over && event.active.id !== event.over.id) {
      move(String(event.active.id), String(event.over.id));
    }
  };
  const offerQuietProjects = async (event: MouseEvent<HTMLButtonElement>) => {
    const api = readLocalApi();
    if (!api) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const clicked = await api.contextMenu.show(
      list.quiet.length > 0
        ? list.quiet.map((group) => ({ id: group.projectKey, label: group.displayName }))
        : [{ id: "", label: "Every project is on the list", disabled: true }],
      { x: Math.round(rect.left), y: Math.round(rect.bottom + 4) },
    );
    if (clicked) add(clicked);
  };

  if (isMobile || groups.length === 0) return null;

  return (
    <div
      ref={rootRef}
      data-rubato-home-projects=""
      className="pointer-events-none absolute inset-x-0 bottom-0 pb-8"
    >
      <div className="chat-composer-lane w-full">
        <div className="pointer-events-auto mx-auto w-full max-w-(--chat-content-max-width) @container">
          <div data-rubato-section="home-tabs" className="flex h-8 items-center gap-1">
            <div
              ref={viewportRef}
              onScroll={readEdges}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overscroll-x-contain py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                // A tab cut by the edge fades out instead of ending mid-letter.
                edges.left && edges.right
                  ? "[mask-image:linear-gradient(to_right,transparent,black_28px,black_calc(100%-28px),transparent)]"
                  : edges.right
                    ? "[mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)]"
                    : edges.left
                      ? "[mask-image:linear-gradient(to_right,transparent,black_28px)]"
                      : null,
              )}
            >
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={list.listed.map((group) => group.projectKey)}
                  strategy={horizontalListSortingStrategy}
                >
                  {list.listed.map((group) => (
                    <ProjectTab
                      key={group.projectKey}
                      group={group}
                      selected={activeGroup?.projectKey === group.projectKey}
                      signal={urgentSignal(signals.get(group.projectKey))}
                      zoom={tabsZoom}
                      onSelect={() => {
                        const entry = pickerEntries.find(
                          (candidate) => candidate.group.projectKey === group.projectKey,
                        );
                        if (!entry || activeGroup?.projectKey === group.projectKey) return;
                        selectProject(entry.targetProject, group.projectKey);
                      }}
                      onRemove={() => remove(group.projectKey)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            </div>
            {edges.left || edges.right ? (
              <>
                <RowButton label="Previous projects" disabled={!edges.left} onClick={() => page(-1)}>
                  <ChevronLeftIcon className="size-4" />
                </RowButton>
                <RowButton
                  label="More projects"
                  disabled={!edges.right}
                  dot={edges.hiddenRightNeedsUser}
                  onClick={() => page(1)}
                >
                  <ChevronRightIcon className="size-4" />
                </RowButton>
              </>
            ) : null}
            <RowButton label="Add a project to the list" onClick={(event) => void offerQuietProjects(event)}>
              <PlusIcon className="size-4" />
            </RowButton>
          </div>
          <div aria-hidden="true" className="mt-1.5 mb-1 h-px bg-border" />
          {homeThreads.length > 0 ? (
            <div
              data-rubato-section="home-threads"
              className="grid grid-flow-col grid-cols-1 grid-rows-3 gap-x-5 @[34rem]:grid-cols-2"
            >
              {homeThreads.map((thread, index) => {
                const key = threadKeyOf(thread);
                return (
                  <div key={key} className={cn("min-w-0", index >= 3 && "hidden @[34rem]:block")}>
                    <RubatoThreadLine
                      thread={thread}
                      project={
                        activeGroup === null
                          ? (projectByMember.get(`${thread.environmentId}:${thread.projectId}`) ?? null)
                          : null
                      }
                      signal={resolveThreadSignal(thread, localLastVisitedAt[key])}
                      density="home"
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <p
              data-rubato-section="home-threads"
              className="flex h-24 items-center px-2.5 text-sm text-muted-foreground"
            >
              No threads here yet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
