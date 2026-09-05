import { replaceOnce } from "./core-replace.mjs";
import { SESSION_LIST_PAGE_SIZE } from "../session-list-page.mjs";

const DISCOVERY_IMPORT_NEEDLE = 'import { readdir } from "fs/promises";\n';
const DISCOVERY_IMPORT_REPLACEMENT = 'import { readdir, stat } from "fs/promises";\n';

const DISCOVERY_LIST_NEEDLE = `/** Build picker rows for every \`.jsonl\` file in one session directory. */
export async function listSessionsFromDir(dir, onProgress, progressOffset = 0, progressTotal) {
    if (!existsSync(dir))
        return [];
    try {
        const dirEntries = await readdir(dir);
        const files = dirEntries.filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
        const total = progressTotal ?? files.length;
        let loaded = 0;
        return await listSessionInfos(files, () => {
            loaded++;
            onProgress?.(progressOffset + loaded, total);
        });
    }
    catch {
        // A directory that cannot be read contributes no picker rows.
        return [];
    }
}`;

const DISCOVERY_LIST_REPLACEMENT = `export const SESSION_LIST_PAGE_SIZE = ${SESSION_LIST_PAGE_SIZE};

export async function sortFilesNewestFirst(files) {
    const stamped = await Promise.all(files.map(async (filePath) => {
        try {
            const stats = await stat(filePath);
            return { filePath, mtimeMs: stats.mtimeMs };
        }
        catch {
            return null;
        }
    }));
    return stamped.filter((entry) => entry !== null).sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.filePath);
}

export async function listJsonlFilesNewestFirst(dir) {
    if (!existsSync(dir))
        return [];
    try {
        const dirEntries = await readdir(dir);
        const files = dirEntries.filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
        return await sortFilesNewestFirst(files);
    }
    catch {
        return [];
    }
}

export async function listSessionsPage(filesNewestFirst, offset = 0, limit = SESSION_LIST_PAGE_SIZE, onProgress) {
    const total = filesNewestFirst.length;
    const start = Math.max(0, offset);
    const page = filesNewestFirst.slice(start, start + Math.max(0, limit));
    let loaded = 0;
    const sessions = await listSessionInfos(page, () => {
        loaded++;
        onProgress?.(start + loaded, total);
    });
    sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    return {
        sessions,
        total,
        offset: start,
        hasMore: start + page.length < total,
    };
}

/** Build picker rows for every \`.jsonl\` file in one session directory. Newest files first. */
export async function listSessionsFromDir(dir, onProgress, progressOffset = 0, progressTotal) {
    if (!existsSync(dir))
        return [];
    try {
        const files = await listJsonlFilesNewestFirst(dir);
        const total = progressTotal ?? files.length;
        let loaded = 0;
        return await listSessionInfos(files, () => {
            loaded++;
            onProgress?.(progressOffset + loaded, total);
        });
    }
    catch {
        return [];
    }
}`;

const MANAGER_IMPORT_NEEDLE = 'import { listSessionInfos, listSessionsFromDir } from "./session-discovery.js";\n';
const MANAGER_IMPORT_REPLACEMENT =
  'import { listJsonlFilesNewestFirst, listSessionInfos, listSessionsFromDir, listSessionsPage, SESSION_LIST_PAGE_SIZE, sortFilesNewestFirst } from "./session-discovery.js";\n';

const MANAGER_LIST_NEEDLE = `    static async list(cwd, sessionDir, onProgress) {
        const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
        const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
        const resolvedCwd = resolvePath(cwd);
        const sessions = (await listSessionsFromDir(dir, onProgress)).filter((session) => !filterCwd || sessionCwdMatches(session.cwd, resolvedCwd));
        sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
        return sessions;
    }`;

const MANAGER_LIST_REPLACEMENT = `    static async list(cwd, sessionDir, onProgress) {
        const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
        const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
        const resolvedCwd = resolvePath(cwd);
        const sessions = (await listSessionsFromDir(dir, onProgress)).filter((session) => !filterCwd || sessionCwdMatches(session.cwd, resolvedCwd));
        sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
        return sessions;
    }
    static async listPage(cwd, sessionDir, onProgress, page = {}) {
        const offset = page.offset ?? 0;
        const limit = page.limit ?? SESSION_LIST_PAGE_SIZE;
        const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
        const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
        const resolvedCwd = resolvePath(cwd);
        const files = await listJsonlFilesNewestFirst(dir);
        const result = await listSessionsPage(files, offset, limit, onProgress);
        if (filterCwd) {
            result.sessions = result.sessions.filter((session) => sessionCwdMatches(session.cwd, resolvedCwd));
        }
        return result;
    }`;

const MANAGER_LIST_ALL_NEEDLE = `    static async listAll(sessionDirOrOnProgress, onProgress) {
        const customSessionDir = typeof sessionDirOrOnProgress === "string" ? normalizePath(sessionDirOrOnProgress) : undefined;
        const progress = typeof sessionDirOrOnProgress === "function" ? sessionDirOrOnProgress : onProgress;
        if (customSessionDir) {
            const sessions = await listSessionsFromDir(customSessionDir, progress);
            sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
            return sessions;
        }
        const sessionsDir = getSessionsDir();
        try {
            if (!existsSync(sessionsDir)) {
                return [];
            }
            const entries = await readdir(sessionsDir, { withFileTypes: true });
            const dirs = entries
                .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
                .map((entry) => join(sessionsDir, entry.name));
            // Count total files first for accurate progress
            let totalFiles = 0;
            const dirFiles = [];
            for (const dir of dirs) {
                try {
                    const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
                    dirFiles.push(files.map((f) => join(dir, f)));
                    totalFiles += files.length;
                }
                catch {
                    dirFiles.push([]);
                }
            }
            // Process all files with progress tracking
            let loaded = 0;
            const sessions = await listSessionInfos(dirFiles.flat(), () => {
                loaded++;
                progress?.(loaded, totalFiles);
            });
            sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
            return sessions;
        }
        catch {
            return [];
        }
    }`;

const MANAGER_LIST_ALL_REPLACEMENT = `    static async collectJsonlNewestFirst(sessionsDir) {
        const entries = await readdir(sessionsDir, { withFileTypes: true });
        const dirs = entries
            .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
            .map((entry) => join(sessionsDir, entry.name));
        const files = [];
        for (const dir of dirs) {
            try {
                const names = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
                files.push(...names.map((f) => join(dir, f)));
            }
            catch {
            }
        }
        return await sortFilesNewestFirst(files);
    }
    static async listAll(sessionDirOrOnProgress, onProgress) {
        const customSessionDir = typeof sessionDirOrOnProgress === "string" ? normalizePath(sessionDirOrOnProgress) : undefined;
        const progress = typeof sessionDirOrOnProgress === "function" ? sessionDirOrOnProgress : onProgress;
        if (customSessionDir) {
            const sessions = await listSessionsFromDir(customSessionDir, progress);
            sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
            return sessions;
        }
        const sessionsDir = getSessionsDir();
        try {
            if (!existsSync(sessionsDir)) {
                return [];
            }
            const files = await this.collectJsonlNewestFirst(sessionsDir);
            let loaded = 0;
            const sessions = await listSessionInfos(files, () => {
                loaded++;
                progress?.(loaded, files.length);
            });
            sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
            return sessions;
        }
        catch {
            return [];
        }
    }
    static async listAllPage(sessionDirOrOnProgress, onProgress, page = {}) {
        const customSessionDir = typeof sessionDirOrOnProgress === "string" ? normalizePath(sessionDirOrOnProgress) : undefined;
        const progress = typeof sessionDirOrOnProgress === "function" ? sessionDirOrOnProgress : onProgress;
        const offset = page.offset ?? 0;
        const limit = page.limit ?? SESSION_LIST_PAGE_SIZE;
        if (customSessionDir) {
            const files = await listJsonlFilesNewestFirst(customSessionDir);
            return await listSessionsPage(files, offset, limit, progress);
        }
        const sessionsDir = getSessionsDir();
        try {
            if (!existsSync(sessionsDir)) {
                return { sessions: [], total: 0, offset, hasMore: false };
            }
            const files = await this.collectJsonlNewestFirst(sessionsDir);
            return await listSessionsPage(files, offset, limit, progress);
        }
        catch {
            return { sessions: [], total: 0, offset, hasMore: false };
        }
    }`;

export function isSessionDiscoveryUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/session-discovery.js");
}

export function isSessionSelectorUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/modes/interactive/components/session-selector.js");
}

export function injectSessionDiscoveryPage(source) {
  let next = replaceOnce(source, DISCOVERY_IMPORT_NEEDLE, DISCOVERY_IMPORT_REPLACEMENT, "session-discovery stat import");
  next = replaceOnce(next, DISCOVERY_LIST_NEEDLE, DISCOVERY_LIST_REPLACEMENT, "session-discovery newest-first page");
  return next;
}

export function injectSessionManagerPage(source) {
  let next = replaceOnce(source, MANAGER_IMPORT_NEEDLE, MANAGER_IMPORT_REPLACEMENT, "session-manager page import");
  next = replaceOnce(next, MANAGER_LIST_NEEDLE, MANAGER_LIST_REPLACEMENT, "session-manager listPage");
  next = replaceOnce(next, MANAGER_LIST_ALL_NEEDLE, MANAGER_LIST_ALL_REPLACEMENT, "session-manager listAllPage");
  return next;
}

const SELECTOR_DOWN_NEEDLE = `        else if (kb.matches(keyData, "tui.select.down")) {
            this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + 1);
        }
        // Page up - jump up by maxVisible items
        else if (kb.matches(keyData, "tui.select.pageUp")) {
            this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
        }
        // Page down - jump down by maxVisible items
        else if (kb.matches(keyData, "tui.select.pageDown")) {
            this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + this.maxVisible);
        }`

const SELECTOR_DOWN_REPLACEMENT = `        else if (kb.matches(keyData, "tui.select.down")) {
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
        }`

const SELECTOR_SEARCH_NEEDLE = `        else {
            this.searchInput.handleInput(keyData);
            this.filterSessions(this.searchInput.getValue());
        }
    }
}`

const SELECTOR_SEARCH_REPLACEMENT = `        else {
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
}`

const SELECTOR_LOAD_NEEDLE = `    async loadScope(scope, reason) {
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
    }`

const SELECTOR_LOAD_REPLACEMENT = `    pageSize() {
        return ${SESSION_LIST_PAGE_SIZE};
    }
    pagingFor(scope) {
        if (scope === "all") {
            this.allPaging ??= { offset: 0, total: 0, hasMore: false, loadingMore: false };
            return this.allPaging;
        }
        this.currentPaging ??= { offset: 0, total: 0, hasMore: false, loadingMore: false };
        return this.currentPaging;
    }
    async invokeLoader(scope, onProgress, page) {
        const loader = scope === "current" ? this.currentSessionsLoader : this.allSessionsLoader;
        const result = await loader(onProgress, page);
        if (Array.isArray(result)) {
            return { sessions: result, total: result.length, offset: 0, hasMore: false };
        }
        return result;
    }
    applyPage(scope, result, append) {
        const paging = this.pagingFor(scope);
        paging.total = result.total;
        paging.hasMore = result.hasMore;
        paging.offset = (result.offset ?? 0) + result.sessions.length;
        if (scope === "current") {
            this.currentSessions = append && this.currentSessions ? [...this.currentSessions, ...result.sessions] : result.sessions;
            this.currentLoading = false;
            return this.currentSessions;
        }
        this.allSessions = append && this.allSessions ? [...this.allSessions, ...result.sessions] : result.sessions;
        this.allLoading = false;
        return this.allSessions;
    }
    async loadScope(scope, reason) {
        const showCwd = scope === "all";
        const paging = this.pagingFor(scope);
        paging.offset = 0;
        paging.hasMore = false;
        paging.loadingMore = false;
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
            const result = await this.invokeLoader(scope, onProgress, { offset: 0, limit: this.pageSize() });
            if (scope !== this.scope)
                return;
            if (seq !== undefined && seq !== this.allLoadSeq)
                return;
            const sessions = this.applyPage(scope, result, false);
            this.header.setLoading(false);
            if (result.hasMore) {
                this.header.setProgress(sessions.length, result.total);
            }
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
    }
    async loadMore(scope, remaining) {
        const paging = this.pagingFor(scope);
        if (!paging.hasMore || paging.loadingMore)
            return;
        if (scope === "current" && this.currentLoading)
            return;
        if (scope === "all" && this.allLoading)
            return;
        paging.loadingMore = true;
        const seq = scope === "all" ? this.allLoadSeq : undefined;
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
            const limit = remaining ? Number.MAX_SAFE_INTEGER : this.pageSize();
            const result = await this.invokeLoader(scope, onProgress, { offset: paging.offset, limit });
            if (scope !== this.scope)
                return;
            if (seq !== undefined && seq !== this.allLoadSeq)
                return;
            const sessions = this.applyPage(scope, result, true);
            this.header.setLoading(false);
            if (result.hasMore) {
                this.header.setProgress(sessions.length, result.total);
            }
            this.sessionList.setSessions(sessions, scope === "all");
            this.requestRender();
        }
        catch (err) {
            paging.loadingMore = false;
            if (scope !== this.scope)
                return;
            const message = err instanceof Error ? err.message : String(err);
            this.header.setLoading(false);
            this.header.setStatusMessage({ type: "error", message: \`Failed to load sessions: \${message}\` }, 4000);
            this.requestRender();
        }
        finally {
            paging.loadingMore = false;
        }
    }`

const SELECTOR_CTOR_NEEDLE = `        // Start loading current sessions immediately
        this.loadCurrentSessions();
    }`

const SELECTOR_CTOR_REPLACEMENT = `        this.sessionList.onNeedMore = (remaining) => {
            void this.loadMore(this.scope, remaining === true);
        };
        this.loadCurrentSessions();
    }`

const INTERACTIVE_LOADER_NEEDLE = `            const selector = new SessionSelectorComponent((onProgress) => SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress), (onProgress) => this.sessionManager.usesDefaultSessionDir()
                ? SessionManager.listAll(onProgress)
                : SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress), async (sessionPath) => {`

const INTERACTIVE_LOADER_REPLACEMENT = `            const selector = new SessionSelectorComponent((onProgress, page) => page
                ? SessionManager.listPage(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress, page)
                : SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress), (onProgress, page) => {
                if (page) {
                    return this.sessionManager.usesDefaultSessionDir()
                        ? SessionManager.listAllPage(onProgress, undefined, page)
                        : SessionManager.listAllPage(this.sessionManager.getSessionDir(), onProgress, page);
                }
                return this.sessionManager.usesDefaultSessionDir()
                    ? SessionManager.listAll(onProgress)
                    : SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress);
            }, async (sessionPath) => {`

const MAIN_LOADER_NEEDLE = `            const selectedPath = await selectSession((onProgress) => SessionManager.list(cwd, sessionDir, onProgress), (onProgress) => SessionManager.listAll(sessionDir, onProgress), settingsManager);`

const MAIN_LOADER_REPLACEMENT = `            const selectedPath = await selectSession((onProgress, page) => page
                ? SessionManager.listPage(cwd, sessionDir, onProgress, page)
                : SessionManager.list(cwd, sessionDir, onProgress), (onProgress, page) => page
                ? SessionManager.listAllPage(sessionDir, onProgress, page)
                : SessionManager.listAll(sessionDir, onProgress), settingsManager);`

export function injectSessionSelectorPage(source) {
  let next = replaceOnce(source, SELECTOR_DOWN_NEEDLE, SELECTOR_DOWN_REPLACEMENT, "session-selector down load-more");
  next = replaceOnce(next, SELECTOR_SEARCH_NEEDLE, SELECTOR_SEARCH_REPLACEMENT, "session-selector search load-more");
  next = replaceOnce(next, SELECTOR_LOAD_NEEDLE, SELECTOR_LOAD_REPLACEMENT, "session-selector paged loadScope");
  next = replaceOnce(next, SELECTOR_CTOR_NEEDLE, SELECTOR_CTOR_REPLACEMENT, "session-selector onNeedMore");
  return next;
}

export function isInteractiveModeSessionListUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/modes/interactive/interactive-mode.js");
}

export function injectInteractiveSessionListPage(source) {
  return replaceOnce(source, INTERACTIVE_LOADER_NEEDLE, INTERACTIVE_LOADER_REPLACEMENT, "interactive-mode paged resume loaders");
}

export function isBootMainSessionListUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/main.js") && !url.includes("/modes/");
}

export function injectMainSessionListPage(source) {
  if (!source.includes(MAIN_LOADER_NEEDLE)) {
    // boot-main-defer splits the selectSession call across a dynamic import.
    const deferredNeedle = `            const selectedPath = await selectSession((onProgress) => SessionManager.list(cwd, sessionDir, onProgress), (onProgress) => SessionManager.listAll(sessionDir, onProgress), settingsManager);`;
    if (!source.includes(deferredNeedle)) return source;
  }
  return replaceOnce(source, MAIN_LOADER_NEEDLE, MAIN_LOADER_REPLACEMENT, "main paged resume loaders");
}
