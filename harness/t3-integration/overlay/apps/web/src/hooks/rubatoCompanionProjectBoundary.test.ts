import { expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  selected: "/private/first",
  homes: ["/private/first", "/private/second"],
  projects: [] as Array<{ id: string; environmentId: string; workspaceRoot: string }>,
  drafts: { getDraftThread: () => null, getDraftSession: () => null },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => new Map() }));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null, useRouter: () => ({ state: { matches: [], location: { href: "/" } } }),
}));
vi.mock("react", async original => ({
  ...(await original<typeof import("react")>()),
  useCallback: <T>(callback: T) => callback, useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../composerDraftStore", () => ({
  composerDraftHasUserContent: () => false, markPromotedDraftThreadByRef: vi.fn(),
  useComposerDraftStore: Object.assign((select: (value: typeof fixture.drafts) => unknown) => select(fixture.drafts),
    { getState: () => fixture.drafts }),
}));
vi.mock("../lib/utils", () => ({ newDraftId: () => "draft", newThreadId: () => "thread" }));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: ({ items }: { items: unknown[] }) => items }));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "project", getProjectOrderKey: (project: { id: string }) => project.id,
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => ({
  readProject: () => null, readProjects: () => fixture.projects, readThreadShell: () => null,
  readThreadShells: () => [], useProjects: () => fixture.projects, useThreadShell: () => null,
}));
vi.mock("../lib/chatThreadActions", () => ({
  hasExplicitComposerModelSelection: () => false, resolveNewDraftStartFromOrigin: () => false,
  resolveNewThreadModelSelectionOverride: () => null,
}));
vi.mock("../lib/t3ProjectFileDefaults", () => ({ readT3ProjectFile: async () => null }));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../threadRoutes", () => ({ resolveThreadRouteTarget: () => null }));
vi.mock("../uiStateStore", () => ({ legacyProjectCwdPreferenceKey: (value: string) => value, useUiStateStore: () => [] }));
vi.mock("./useSidebarProjectGroups", () => ({ useSidebarProjectGroups: () => fixture.projects }));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => "local" }));
vi.mock("../state/session", () => ({ usePreparedConnection: () => null }));
vi.mock("../state/rubatoHttp", () => ({ postRubato: vi.fn() }));
vi.mock("../state/rubatoCompanion", async original => ({
  ...(await original<typeof import("../state/rubatoCompanion")>()),
  useRubatoCompanion: () => ({ status: { home: fixture.selected },
    companions: fixture.homes.map((home, at) => ({ id: `companion-${at}`, home })) }),
}));

import { useHandleNewThread } from "./useHandleNewThread";

const project = (workspaceRoot: string, id: string) => ({ workspaceRoot, id, environmentId: "local" });
it.each(["/private/first", "/private/second"])("never offers either companion as an ordinary new-thread home, selected=%s", selected => {
  fixture.selected = selected;
  fixture.projects = [project("/private/second", "second"), project("/private/first", "first"), project("/work", "work")];
  expect(useHandleNewThread().defaultProjectRef).toEqual({ environmentId: "local", projectId: "work" });
});
it("returns no default instead of falling back into a companion repository", () => {
  fixture.projects = [project("/private/second", "second"), project("/private/first", "first")];
  expect(useHandleNewThread().defaultProjectRef).toBeNull();
});
