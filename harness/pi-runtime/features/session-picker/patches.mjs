import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_VERSION = "0.86.1";
const PAGER_IMPORT = 'import { SessionPickerPager } from "../../../rubato-features/session-picker/pager.mjs";';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`[session-picker:${label}] expected anchor is missing`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[session-picker:${label}] expected anchor is ambiguous`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function unpatched(source, marker, label) {
  if (source.includes(marker)) throw new Error(`[session-picker:${label}] expected pristine feature seam`);
}

function patch(path, preimageSha256, apply) {
  return Object.freeze({
    id: `session-picker:${path}`,
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path,
    preimageSha256,
    apply,
  });
}

function patchSelectorRuntime(source) {
  unpatched(source, PAGER_IMPORT, "selector-runtime");
  let next = replaceOnce(
    source,
    'import { filterAndSortSessions, hasSessionName } from "./session-selector-search.js";',
    `import { filterAndSortSessions, hasSessionName } from "./session-selector-search.js";\n${PAGER_IMPORT}`,
    "pager-import",
  );
  next = replaceOnce(
    next,
    `    onRenameSession;
    onError;
    maxVisible = 10;`,
    `    onRenameSession;
    onError;
    onNeedMore;
    maxVisible = 10;`,
    "list-more-callback",
  );
  next = replaceOnce(
    next,
    `        else if (kb.matches(keyData, "tui.select.down")) {
            this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + 1);
        }
        // Page up - jump up by maxVisible items
        else if (kb.matches(keyData, "tui.select.pageUp")) {
            this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
        }
        // Page down - jump down by maxVisible items
        else if (kb.matches(keyData, "tui.select.pageDown")) {
            this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + this.maxVisible);
        }`,
    `        else if (kb.matches(keyData, "tui.select.down")) {
            this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + 1);
            this.maybeRequestMore();
        }
        // Page up - jump up by maxVisible items
        else if (kb.matches(keyData, "tui.select.pageUp")) {
            this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
        }
        // Page down - jump down by maxVisible items
        else if (kb.matches(keyData, "tui.select.pageDown")) {
            this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + this.maxVisible);
            this.maybeRequestMore();
        }`,
    "navigation-load-more",
  );
  next = replaceOnce(
    next,
    `        else {
            this.searchInput.handleInput(keyData);
            this.filterSessions(this.searchInput.getValue());
        }
    }
}`,
    `        else {
            this.searchInput.handleInput(keyData);
            this.filterSessions(this.searchInput.getValue());
            if (this.searchInput.getValue().trim()) {
                this.onNeedMore?.(true);
            }
        }
    }
    maybeRequestMore() {
        if (this.filteredSessions.length === 0)
            return;
        if (this.selectedIndex >= this.filteredSessions.length - 3) {
            this.onNeedMore?.(false);
        }
    }
}`,
    "search-load-more",
  );
  next = replaceOnce(
    next,
    `    currentLoad = null;
    allLoad = null;`,
    `    currentLoad = null;
    allLoad = null;
    currentPaging = new SessionPickerPager();
    allPaging = new SessionPickerPager();`,
    "scope-pagers",
  );
  next = replaceOnce(
    next,
    `        // Start loading current sessions immediately
        void this.loadScope("current");`,
    `        this.sessionList.onNeedMore = (remaining) => {
            void this.loadMore(this.scope, remaining === true);
        };
        // Start loading current sessions immediately
        void this.loadScope("current");`,
    "bind-more-callback",
  );
  next = replaceOnce(
    next,
    `    enterRenameMode(sessionPath, currentName) {
        this.mode = "rename";`,
    `    disposePaging() {
        this.currentPaging.reset();
        this.allPaging.reset();
        this.cancelLoads();
    }
    pagingFor(scope) {
        return scope === "all" ? this.allPaging : this.currentPaging;
    }
    enterRenameMode(sessionPath, currentName) {
        this.mode = "rename";`,
    "paging-helpers",
  );
  next = replaceOnce(
    next,
    `        const isActive = () => (scope === "current" ? this.currentLoad : this.allLoad) === controller;`,
    `        const isActive = () => (scope === "current" ? this.currentLoad : this.allLoad) === controller;
        const pager = this.pagingFor(scope);
        pager.reset();`,
    "pager-reset",
  );
  next = replaceOnce(
    next,
    `            const sessions = await (scope === "current"
                ? this.currentSessionsLoader(onProgress, controller.signal)
                : this.allSessionsLoader(onProgress, controller.signal));`,
    `            const loadPage = async (loader) => {
                const request = pager.request();
                const result = await loader(onProgress, request, controller.signal);
                return pager.apply(result, [], { append: false, request });
            };
            const sessions = await (scope === "current"
                ? loadPage(this.currentSessionsLoader)
                : loadPage(this.allSessionsLoader));`,
    "paged-first-page",
  );
  next = replaceOnce(
    next,
    `            this.header.setLoading(false);
            this.sessionList.setSessions(sessions, showCwd);
            this.requestRender();`,
    `            this.header.setLoading(false);
            if (pager.hasMore) {
                this.header.setProgress(sessions.length, pager.total);
            }
            this.sessionList.setSessions(sessions, showCwd);
            this.requestRender();`,
    "paged-progress",
  );
  next = replaceOnce(
    next,
    `    toggleSortMode() {
        // Cycle: threaded -> recent -> relevance -> threaded`,
    `    async loadMore(scope, remaining) {
        const pager = this.pagingFor(scope);
        const generation = pager.beginMore();
        if (generation === undefined)
            return;
        if (scope === "current" ? this.currentLoad : this.allLoad) {
            pager.finishMore(generation);
            return;
        }
        const controller = new AbortController();
        if (scope === "current") {
            this.currentLoad = controller;
        }
        else {
            this.allLoad = controller;
        }
        const isActive = () => (scope === "current" ? this.currentLoad : this.allLoad) === controller;
        const loader = scope === "current" ? this.currentSessionsLoader : this.allSessionsLoader;
        if (scope === this.scope) {
            this.header.setLoading(true);
            this.requestRender();
        }
        const onProgress = (loaded, total) => {
            if (!isActive() || scope !== this.scope)
                return;
            this.header.setProgress(loaded, total);
            this.requestRender();
        };
        try {
            do {
                const request = pager.request({ remaining });
                const result = await loader(onProgress, request, controller.signal);
                if (!isActive())
                    return;
                const current = scope === "all" ? (this.allSessions ?? []) : (this.currentSessions ?? []);
                const sessions = pager.apply(result, current, { append: true, request });
                if (scope === "current") {
                    this.currentSessions = sessions;
                }
                else {
                    this.allSessions = sessions;
                }
                if (scope === this.scope) {
                    this.sessionList.setSessions(sessions, scope === "all");
                    this.header.setProgress(sessions.length, pager.total);
                    this.requestRender();
                }
            } while (remaining && pager.hasMore);
        }
        catch (err) {
            if (isActive() && scope === this.scope) {
                const message = err instanceof Error ? err.message : String(err);
                this.header.setStatusMessage({ type: "error", message: \`Failed to load sessions: \${message}\` }, 4000);
                this.requestRender();
            }
        }
        finally {
            if (isActive()) {
                if (scope === "current") {
                    this.currentLoad = null;
                }
                else {
                    this.allLoad = null;
                }
                if (scope === this.scope) {
                    this.header.setLoading(false);
                    this.requestRender();
                }
            }
            pager.finishMore(generation);
        }
    }
    toggleSortMode() {
        // Cycle: threaded -> recent -> relevance -> threaded`,
    "load-more",
  );
  return next;
}

function patchSelectorTypes(source) {
  let next = replaceOnce(
    source,
    `import type { SessionInfo, SessionListProgress } from "../../../core/session-manager.ts";`,
    `import type { SessionInfo, SessionListPageOptions, SessionListPageResult, SessionListProgress } from "../../../core/session-manager.ts";`,
    "selector-page-types",
  );
  next = replaceOnce(
    next,
    `    onRenameSession?: (sessionPath: string) => void;
    onError?: (message: string) => void;
    private maxVisible;`,
    `    onRenameSession?: (sessionPath: string) => void;
    onError?: (message: string) => void;
    onNeedMore?: (remaining: boolean) => void;
    private maxVisible;`,
    "list-more-type",
  );
  next = replaceOnce(
    next,
    `    private buildTreePrefix;
    handleInput(keyData: string): void;
}
type SessionsLoader = (onProgress?: SessionListProgress, signal?: AbortSignal) => Promise<SessionInfo[]>;`,
    `    private buildTreePrefix;
    handleInput(keyData: string): void;
    private maybeRequestMore;
}
type SessionsLoader = (onProgress?: SessionListProgress, page?: SessionListPageOptions, signal?: AbortSignal) => Promise<SessionInfo[] | SessionListPageResult>;`,
    "loader-type",
  );
  next = replaceOnce(
    next,
    `    private currentLoad;
    private allLoad;
    private mode;`,
    `    private currentLoad;
    private allLoad;
    private currentPaging;
    private allPaging;
    private mode;`,
    "pager-fields-type",
  );
  next = replaceOnce(
    next,
    `    private confirmRename;
    private loadScope;`,
    `    private confirmRename;
    disposePaging(): void;
    private pagingFor;
    private loadMore;
    private loadScope;`,
    "pager-methods-type",
  );
  return next;
}

function patchInteractiveRuntime(source) {
  let next = replaceOnce(
    source,
    `            const selector = new SessionSelectorComponent((onProgress, signal) => SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress, signal), (onProgress, signal) => this.sessionManager.usesDefaultSessionDir()
                ? SessionManager.listAll(onProgress, signal)
                : SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress, signal), async (sessionPath) => {`,
    `            const selector = new SessionSelectorComponent((onProgress, page, signal) => page
                ? SessionManager.listPage(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress, page, signal)
                : SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress, signal), (onProgress, page, signal) => {
                if (page) {
                    return this.sessionManager.usesDefaultSessionDir()
                        ? SessionManager.listAllPage(onProgress, page, signal)
                        : SessionManager.listAllPage(this.sessionManager.getSessionDir(), onProgress, page, signal);
                }
                return this.sessionManager.usesDefaultSessionDir()
                    ? SessionManager.listAll(onProgress, signal)
                    : SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress, signal);
            }, async (sessionPath) => {`,
    "interactive-page-loaders",
  );
  next = replaceOnce(
    next,
    `            return { component: selector, focus: selector };
        });
    }
    async handleResumeSession(sessionPath, options) {`,
    `            return { component: selector, focus: selector, dispose: () => selector.disposePaging() };
        });
    }
    async handleResumeSession(sessionPath, options) {`,
    "interactive-dispose",
  );
  return next;
}

function patchMainRuntime(source) {
  return replaceOnce(
    source,
    `            const selectedPath = await selectSession((onProgress, signal) => SessionManager.list(cwd, sessionDir, onProgress, signal), (onProgress, signal) => SessionManager.listAll(sessionDir, onProgress, signal), settingsManager);`,
    `            const selectedPath = await selectSession((onProgress, page, signal) => page
                ? SessionManager.listPage(cwd, sessionDir, onProgress, page, signal)
                : SessionManager.list(cwd, sessionDir, onProgress, signal), (onProgress, page, signal) => page
                ? SessionManager.listAllPage(sessionDir, onProgress, page, signal)
                : SessionManager.listAll(sessionDir, onProgress, signal), settingsManager);`,
    "startup-page-loaders",
  );
}

function patchPickerTypes(source) {
  let next = replaceOnce(
    source,
    `import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";`,
    `import type { SessionInfo, SessionListPageOptions, SessionListPageResult, SessionListProgress } from "../core/session-manager.ts";`,
    "picker-page-types",
  );
  next = replaceOnce(
    next,
    `type SessionsLoader = (onProgress?: SessionListProgress, signal?: AbortSignal) => Promise<SessionInfo[]>;`,
    `type SessionsLoader = (onProgress?: SessionListProgress, page?: SessionListPageOptions, signal?: AbortSignal) => Promise<SessionInfo[] | SessionListPageResult>;`,
    "picker-loader-type",
  );
  return next;
}

function patchPickerRuntime(source) {
  let next = replaceOnce(
    source,
    `        let resolved = false;
        const selector = new SessionSelectorComponent(currentSessionsLoader, allSessionsLoader, (path) => {`,
    `        let resolved = false;
        let selector;
        const finish = (value) => {
            if (resolved)
                return;
            resolved = true;
            selector?.disposePaging();
            ui.stop();
            resolve(value);
        };
        selector = new SessionSelectorComponent(currentSessionsLoader, allSessionsLoader, (path) => {`,
    "startup-finish",
  );
  next = replaceOnce(
    next,
    `            if (!resolved) {
                resolved = true;
                ui.stop();
                resolve(path);
            }
        }, () => {
            if (!resolved) {
                resolved = true;
                ui.stop();
                resolve(null);
            }
        }, () => {
            ui.stop();
            process.exit(0);`,
    `            finish(path);
        }, () => {
            finish(null);
        }, () => {
            selector?.disposePaging();
            ui.stop();
            process.exit(0);`,
    "startup-settle",
  );
  return next;
}

export const files = Object.freeze([
  Object.freeze({
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path: "dist/rubato-features/session-picker/pager.mjs",
    sourcePath: fileURLToPath(new URL("./pager.mjs", import.meta.url)),
  }),
]);

export const patches = Object.freeze([
  patch("dist/modes/interactive/components/session-selector.js", "926e788829f9cb8eb1792f56b5b23e74f575db88606968a60948e2ce45806296", patchSelectorRuntime),
  patch("dist/modes/interactive/components/session-selector.d.ts", "b2c8a390ad9a001c93ee0e035525ade3300d6f2d2233bb58b59691f5f8392f39", patchSelectorTypes),
  patch("dist/modes/interactive/interactive-mode.js", "8c9275944466afe2df78dcf02f2f6c83f6bc46fb0fdbd7257a3ef9d1da1ed027", patchInteractiveRuntime),
  patch("dist/main.js", "e36837e55af695cbb95216763fbc929e87829ced837dd32f281bba8c8e50035c", patchMainRuntime),
  patch("dist/cli/session-picker.js", "b5b3cc89815cc11f4519af27b9abb5a972a110fcfa08096f70dc0623e763cd44", patchPickerRuntime),
  patch("dist/cli/session-picker.d.ts", "ceb19ff55fbeea924167a77fb7cb373e03a265226b6abec580c4f7046a831734", patchPickerTypes),
]);

export const feature = Object.freeze({ id: "session-picker", patches, files });
