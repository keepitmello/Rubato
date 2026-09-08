import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_VERSION = "0.85.1";
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
    `    setSessions(sessions, showCwd) {
        this.allSessions = sessions;
        this.showCwd = showCwd;
        this.filterSessions(this.searchInput.getValue());
    }`,
    `    setSessions(sessions, showCwd) {
        const selectedPath = canonicalizePath(this.getSelectedSessionPath());
        this.allSessions = sessions;
        this.showCwd = showCwd;
        this.filterSessions(this.searchInput.getValue());
        if (selectedPath) {
            const nextIndex = this.filteredSessions.findIndex((entry) => canonicalizePath(entry.session.path) === selectedPath);
            if (nextIndex !== -1)
                this.selectedIndex = nextIndex;
        }
    }`,
    "preserve-selected-path",
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
    `    currentLoading = false;
    allLoading = false;
    allLoadSeq = 0;`,
    `    currentLoading = false;
    allLoading = false;
    allLoadSeq = 0;
    currentPaging = new SessionPickerPager();
    allPaging = new SessionPickerPager();`,
    "scope-pagers",
  );
  next = replaceOnce(
    next,
    `        // Start loading current sessions immediately
        this.loadCurrentSessions();`,
    `        this.sessionList.onNeedMore = (remaining) => {
            void this.loadMore(this.scope, remaining === true);
        };
        // Start loading current sessions immediately
        this.loadCurrentSessions();`,
    "bind-more-callback",
  );
  next = replaceOnce(
    next,
    `    async loadScope(scope, reason) {
        const showCwd = scope === "all";
        // Mark loading
        if (scope === "current") {
            this.currentLoading = true;
        }
        else {
            this.allLoading = true;
        }
        const seq = scope === "all" ? ++this.allLoadSeq : undefined;
        this.header.setScope(scope);
        this.header.setLoading(true);
        this.requestRender();
        const onProgress = (loaded, total) => {
            if (scope !== this.scope)
                return;
            if (seq !== undefined && seq !== this.allLoadSeq)
                return;
            this.header.setProgress(loaded, total);
            this.requestRender();
        };
        try {
            const sessions = await (scope === "current"
                ? this.currentSessionsLoader(onProgress)
                : this.allSessionsLoader(onProgress));
            if (scope === "current") {
                this.currentSessions = sessions;
                this.currentLoading = false;
            }
            else {
                this.allSessions = sessions;
                this.allLoading = false;
            }
            if (scope !== this.scope)
                return;
            if (seq !== undefined && seq !== this.allLoadSeq)
                return;
            this.header.setLoading(false);
            this.sessionList.setSessions(sessions, showCwd);
            this.requestRender();
        }
        catch (err) {
            if (scope === "current") {
                this.currentLoading = false;
            }
            else {
                this.allLoading = false;
            }
            if (scope !== this.scope)
                return;
            if (seq !== undefined && seq !== this.allLoadSeq)
                return;
            const message = err instanceof Error ? err.message : String(err);
            this.header.setLoading(false);
            this.header.setStatusMessage({ type: "error", message: \`Failed to load sessions: \${message}\` }, 4000);
            if (reason === "initial") {
                this.sessionList.setSessions([], showCwd);
            }
            this.requestRender();
        }
    }`,
    `    disposePaging() {
        this.currentPaging.reset();
        this.allPaging.reset();
        this.currentLoading = false;
        this.allLoading = false;
    }
    pagingFor(scope) {
        return scope === "all" ? this.allPaging : this.currentPaging;
    }
    async invokeLoader(scope, onProgress, page) {
        const loader = scope === "current" ? this.currentSessionsLoader : this.allSessionsLoader;
        return loader(onProgress, page);
    }
    applyPage(scope, pager, result, append, request) {
        const current = scope === "all" ? (this.allSessions ?? []) : (this.currentSessions ?? []);
        const sessions = pager.apply(result, current, { append, request });
        if (scope === "current") {
            this.currentSessions = sessions;
            this.currentLoading = false;
        }
        else {
            this.allSessions = sessions;
            this.allLoading = false;
        }
        return sessions;
    }
    async loadScope(scope, reason) {
        const showCwd = scope === "all";
        const pager = this.pagingFor(scope);
        const generation = pager.reset();
        if (scope === "current") {
            this.currentLoading = true;
        }
        else {
            this.allLoading = true;
            this.allLoadSeq++;
        }
        this.header.setScope(scope);
        this.header.setLoading(true);
        this.requestRender();
        const onProgress = (loaded, total) => {
            if (scope !== this.scope || !pager.isCurrent(generation))
                return;
            this.header.setProgress(loaded, total);
            this.requestRender();
        };
        try {
            const request = pager.request();
            const result = await this.invokeLoader(scope, onProgress, request);
            if (!pager.isCurrent(generation))
                return;
            const sessions = this.applyPage(scope, pager, result, false, request);
            if (scope !== this.scope)
                return;
            this.header.setLoading(false);
            if (pager.hasMore) {
                this.header.setProgress(sessions.length, pager.total);
            }
            this.sessionList.setSessions(sessions, showCwd);
            this.requestRender();
        }
        catch (err) {
            if (!pager.isCurrent(generation))
                return;
            if (scope === "current") {
                this.currentLoading = false;
            }
            else {
                this.allLoading = false;
            }
            if (scope !== this.scope)
                return;
            const message = err instanceof Error ? err.message : String(err);
            this.header.setLoading(false);
            this.header.setStatusMessage({ type: "error", message: \`Failed to load sessions: \${message}\` }, 4000);
            if (reason === "initial") {
                this.sessionList.setSessions([], showCwd);
            }
            this.requestRender();
        }
    }
    async loadMore(scope, remaining) {
        const pager = this.pagingFor(scope);
        const generation = pager.beginMore();
        if (generation === undefined)
            return;
        if (scope === "current" && this.currentLoading) {
            pager.finishMore(generation);
            return;
        }
        if (scope === "all" && this.allLoading) {
            pager.finishMore(generation);
            return;
        }
        this.header.setLoading(true);
        this.requestRender();
        const onProgress = (loaded, total) => {
            if (scope !== this.scope || !pager.isCurrent(generation))
                return;
            this.header.setProgress(loaded, total);
            this.requestRender();
        };
        try {
            do {
                const request = pager.request({ remaining });
                const result = await this.invokeLoader(scope, onProgress, request);
                if (scope !== this.scope || !pager.isCurrent(generation))
                    return;
                const sessions = this.applyPage(scope, pager, result, true, request);
                this.sessionList.setSessions(sessions, scope === "all");
                this.header.setProgress(sessions.length, pager.total);
                this.requestRender();
            } while (remaining && pager.hasMore);
            if (scope === this.scope && pager.isCurrent(generation)) {
                this.header.setLoading(false);
                this.requestRender();
            }
        }
        catch (err) {
            if (scope !== this.scope || !pager.isCurrent(generation))
                return;
            const message = err instanceof Error ? err.message : String(err);
            this.header.setLoading(false);
            this.header.setStatusMessage({ type: "error", message: \`Failed to load sessions: \${message}\` }, 4000);
            this.requestRender();
        }
        finally {
            pager.finishMore(generation);
        }
    }`,
    "paged-loaders",
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
type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;`,
    `    private buildTreePrefix;
    handleInput(keyData: string): void;
    private maybeRequestMore;
}
type SessionsLoader = (onProgress?: SessionListProgress, page?: SessionListPageOptions) => Promise<SessionInfo[] | SessionListPageResult>;`,
    "loader-type",
  );
  next = replaceOnce(
    next,
    `    private allLoadSeq;
    private mode;`,
    `    private allLoadSeq;
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
    private invokeLoader;
    private applyPage;
    private loadScope;
    private loadMore;`,
    "pager-methods-type",
  );
  return next;
}

function patchInteractiveRuntime(source) {
  let next = replaceOnce(
    source,
    `            const selector = new SessionSelectorComponent((onProgress) => SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress), (onProgress) => this.sessionManager.usesDefaultSessionDir()
                ? SessionManager.listAll(onProgress)
                : SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress), async (sessionPath) => {`,
    `            const selector = new SessionSelectorComponent((onProgress, page) => page
                ? SessionManager.listPage(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress, page)
                : SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress), (onProgress, page) => {
                if (page) {
                    return this.sessionManager.usesDefaultSessionDir()
                        ? SessionManager.listAllPage(onProgress, page)
                        : SessionManager.listAllPage(this.sessionManager.getSessionDir(), onProgress, page);
                }
                return this.sessionManager.usesDefaultSessionDir()
                    ? SessionManager.listAll(onProgress)
                    : SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress);
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
    `            const selectedPath = await selectSession((onProgress) => SessionManager.list(cwd, sessionDir, onProgress), (onProgress) => SessionManager.listAll(sessionDir, onProgress), settingsManager);`,
    `            const selectedPath = await selectSession((onProgress, page) => page
                ? SessionManager.listPage(cwd, sessionDir, onProgress, page)
                : SessionManager.list(cwd, sessionDir, onProgress), (onProgress, page) => page
                ? SessionManager.listAllPage(sessionDir, onProgress, page)
                : SessionManager.listAll(sessionDir, onProgress), settingsManager);`,
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
    `type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;`,
    `type SessionsLoader = (onProgress?: SessionListProgress, page?: SessionListPageOptions) => Promise<SessionInfo[] | SessionListPageResult>;`,
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
  patch("dist/modes/interactive/components/session-selector.js", "d2effa5dc1c1dede7baf4080ac6b50bf1808932a4667288aa3255c485e1e8129", patchSelectorRuntime),
  patch("dist/modes/interactive/components/session-selector.d.ts", "776a3ad2221b1cd6b3af9559921c6b592cbd048852495549001ca4b9a958263e", patchSelectorTypes),
  patch("dist/modes/interactive/interactive-mode.js", "802ff14f5a47710e5a46d8141b238c4d5ffca30e8ca26bad18f838eddbf086bf", patchInteractiveRuntime),
  patch("dist/main.js", "f0b7e5a8419af8d149ffe367af2992c76ce70b73484c15492bd50787d4f4962a", patchMainRuntime),
  patch("dist/cli/session-picker.js", "b5b3cc89815cc11f4519af27b9abb5a972a110fcfa08096f70dc0623e763cd44", patchPickerRuntime),
  patch("dist/cli/session-picker.d.ts", "43b7843f3104685c58d5967b9362a4aa9f62e7c7b38e4c75e7bc23291a14956c", patchPickerTypes),
]);

export const feature = Object.freeze({ id: "session-picker", patches, files });
