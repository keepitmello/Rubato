// Rubato: the thread folder filter in the phone's list options (thread-folders-edits.mjs).
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const saved = vi.hoisted(() => [] as unknown[]);
vi.mock("../../state/preferences", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    updateMobilePreferencesAtom: Atom.writable(
      () => null,
      (_ctx, patch: unknown) => {
        saved.push(patch);
      },
    ),
  };
});

import type { ThreadListFilters } from "../../persistence/mobile-preferences";
import { HomeListOptionsProvider, useHomeListFolder, useHomeListOptions } from "./home-list-options";

describe("Rubato thread folder filter", () => {
  const environmentId = EnvironmentId.make("environment-1");
  const availableEnvironmentIds = new Set([environmentId]);
  let root: Root;
  let latest: ReturnType<typeof useHomeListOptions>;
  let folder: ReturnType<typeof useHomeListFolder>;

  function ThreadList() {
    const state = useHomeListOptions(availableEnvironmentIds);
    const folderState = useHomeListFolder();
    useLayoutEffect(() => {
      latest = state;
      folder = folderState;
    });
    return null;
  }

  const registry = AtomRegistry.make();
  let container: unknown;

  async function showLayout(layout: "compact" | "sidebar", savedFilters?: ThreadListFilters) {
    await act(() => {
      root.render(
        createElement(
          RegistryContext,
          { value: registry },
          createElement(
            HomeListOptionsProvider,
            { projectGroupingMode: "repository", savedFilters },
            // Replace the list while keeping the workspace provider mounted.
            createElement(ThreadList, { key: layout }),
          ),
        ),
      );
    });
  }

  beforeEach(() => {
    // The hook probe renders no DOM, but ReactDOM needs an event target.
    const document = {
      nodeType: 9,
      addEventListener() {},
      removeEventListener() {},
    };
    container = {
      nodeType: 1,
      tagName: "DIV",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      ownerDocument: document,
      addEventListener() {},
      removeEventListener() {},
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(container as unknown as HTMLElement);
    saved.length = 0;
  });

  afterEach(async () => {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("is saved with the other filters, kept across layouts and restored on launch", async () => {
    await showLayout("compact", { environmentId, projectKey: null });
    expect(folder[0]).toBeNull();

    await act(() => folder[1]("folder-a"));
    expect(saved).toEqual([
      { threadListFilters: { environmentId, projectKey: null, rubatoFolderId: "folder-a" } },
    ]);
    await showLayout("sidebar");
    expect(folder[0]).toBe("folder-a");
    expect(latest.options.selectedEnvironmentId).toBe(environmentId);

    await act(() => root.unmount());
    root = createRoot(container as HTMLElement);
    await showLayout("compact", { environmentId, projectKey: null, rubatoFolderId: "folder-a" });
    expect(folder[0]).toBe("folder-a");

    await act(() => folder[1](null));
    expect(saved.at(-1)).toEqual({ threadListFilters: { environmentId, projectKey: null } });
  });
});
