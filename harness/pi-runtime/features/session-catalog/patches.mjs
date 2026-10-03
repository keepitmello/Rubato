import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
import { PI_VERSION as PACKAGE_VERSION } from "../../pi-version.mjs";
const CATALOG_IMPORT = 'import { listSessionCatalogPage } from "../rubato-features/session-catalog/catalog.mjs";';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`[session-catalog:${label}] expected anchor is missing`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[session-catalog:${label}] expected anchor is ambiguous`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function unpatched(source, marker, label) {
  if (source.includes(marker)) {
    throw new Error(`[session-catalog:${label}] expected anchor is missing (already patched)`);
  }
}

function patch(path, preimageSha256, apply) {
  return Object.freeze({
    id: `session-catalog:${path}`,
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path,
    preimageSha256,
    apply,
  });
}

function patchSessionManagerRuntime(source) {
  unpatched(source, CATALOG_IMPORT, "session-manager");
  let next = replaceOnce(
    source,
    'import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage, } from "./messages.js";',
    `import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage, } from "./messages.js";\n${CATALOG_IMPORT}`,
    "catalog-import",
  );
  // Stock 1.0 writes the file at the first user message itself (_hasConversation, #10000),
  // which is the rule Rubato used to patch in; nothing to change here any more.
  // Rolling back memory is half of it; the file must lose the failed write too. A failed
  // first flush left an empty file behind, so every later "wx" open hit EEXIST until a
  // restart. A failed append can leave a torn line without a newline; the next append
  // glued onto it, the reader skipped the joined line, and the entry after it pointed at
  // a parent the file no longer had. truncate and unlink need no free space.
  next = replaceOnce(
    next,
    `import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync, } from "fs";`,
    `import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, truncateSync, writeFileSync, } from "fs";`,
    "file-rollback-imports",
  );
  next = replaceOnce(
    next,
    `            const fd = openSync(this.sessionFile, "wx");
            try {
                for (const e of this.fileEntries) {
                    writeFileSync(fd, \`\${JSON.stringify(e)}\\n\`);
                }
            }
            finally {
                closeSync(fd);
            }
            this.flushed = true;
        }
        else {
            appendFileSync(this.sessionFile, \`\${JSON.stringify(entry)}\\n\`);
        }`,
    `            const fd = openSync(this.sessionFile, "wx");
            try {
                for (const e of this.fileEntries) {
                    writeFileSync(fd, \`\${JSON.stringify(e)}\\n\`);
                }
            }
            catch (error) {
                closeSync(fd);
                rmSync(this.sessionFile, { force: true });
                throw error;
            }
            closeSync(fd);
            this.flushed = true;
        }
        else {
            this._appendLine(entry);
        }`,
    "file-rollback-first-flush",
  );
  // Stock records the entry in memory before writing it. When the write fails (a full
  // disk), memory keeps an entry the file never got, the next entry takes it as parent,
  // and after a restart that parent is missing from the file and the session will not open.
  next = replaceOnce(
    next,
    `    _appendEntry(entry) {
        this.fileEntries.push(entry);
        this.byId.set(entry.id, entry);
        this.leafId = entry.id;
        this._persist(entry);
    }`,
    `    _appendLine(entry) {
        const length = statSync(this.sessionFile, { throwIfNoEntry: false })?.size ?? 0;
        try {
            appendFileSync(this.sessionFile, \`\${JSON.stringify(entry)}\\n\`);
        }
        catch (error) {
            try {
                truncateSync(this.sessionFile, length);
            }
            catch { }
            throw error;
        }
    }
    _appendEntry(entry) {
        const previousLeafId = this.leafId;
        this.fileEntries.push(entry);
        this.byId.set(entry.id, entry);
        this.leafId = entry.id;
        try {
            this._persist(entry);
        }
        catch (error) {
            this.fileEntries.pop();
            this.byId.delete(entry.id);
            this.leafId = previousLeafId;
            throw error;
        }
    }`,
    "append-rollback",
  );
  next = replaceOnce(
    next,
    `    static async listAll(sessionDirOrOnProgress, onProgressOrSignal, signal) {`,
    `    static async listPage(cwd, sessionDir, onProgress, page = {}, signal) {
        const resolvedCwd = resolvePath(cwd);
        const encoded = getDefaultSessionDirPath(cwd);
        const sessionsRoot = getSessionsDir();
        const dir = sessionDir ? normalizePath(sessionDir) : encoded;
        const defaultTree = !sessionDir || dir === encoded || dir === sessionsRoot;
        return listSessionCatalogPage({
            root: defaultTree ? sessionsRoot : dir,
            includeSubdirectories: defaultTree,
            readHeader: readSessionHeaderForDiscovery,
            acceptHeader: (header) => sessionCwdMatches(getSessionHeaderCwd(header), resolvedCwd),
            buildInfo: buildSessionInfo,
            onProgress,
            page,
            signal,
        });
    }
    static async listAllPage(sessionDirOrProgress, progressOrPage, pageOrSignal, signal) {
        const customSessionDir = typeof sessionDirOrProgress === "string" ? normalizePath(sessionDirOrProgress) : undefined;
        const progress = typeof sessionDirOrProgress === "function" ? sessionDirOrProgress : progressOrPage;
        const page = typeof sessionDirOrProgress === "function" ? progressOrPage : pageOrSignal;
        const effectiveSignal = typeof sessionDirOrProgress === "function" ? pageOrSignal : signal;
        return listSessionCatalogPage({
            root: customSessionDir ?? getSessionsDir(),
            includeSubdirectories: customSessionDir === undefined,
            readHeader: readSessionHeaderForDiscovery,
            buildInfo: buildSessionInfo,
            onProgress: progress,
            page,
            signal: effectiveSignal,
        });
    }
    static async listAll(sessionDirOrOnProgress, onProgressOrSignal, signal) {`,
    "paged-api",
  );
  return next;
}

function patchSessionManagerTypes(source) {
  unpatched(source, "export interface SessionListPageResult", "session-manager-types");
  let next = replaceOnce(
    source,
    `export type SessionListProgress = `,
    `export interface SessionListPageOptions {
    offset?: number;
    limit?: number;
    query?: string;
}
export interface SessionListPageResult {
    sessions: SessionInfo[];
    total: number;
    offset: number;
    hasMore: boolean;
}
export type SessionListProgress = `,
    "page-types",
  );
  next = replaceOnce(
    next,
    `    static list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress, signal?: AbortSignal): Promise<SessionInfo[]>;
    /**
     * List all sessions across all project directories.`,
    `    static list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress, signal?: AbortSignal): Promise<SessionInfo[]>;
    static listPage(cwd: string, sessionDir?: string, onProgress?: SessionListProgress, page?: SessionListPageOptions, signal?: AbortSignal): Promise<SessionListPageResult>;
    static listAllPage(onProgress?: SessionListProgress, page?: SessionListPageOptions, signal?: AbortSignal): Promise<SessionListPageResult>;
    static listAllPage(sessionDir?: string, onProgress?: SessionListProgress, page?: SessionListPageOptions, signal?: AbortSignal): Promise<SessionListPageResult>;
    /**
     * List all sessions across all project directories.`,
    "page-methods",
  );
  return next;
}

export const files = Object.freeze([
  Object.freeze({
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path: "dist/rubato-features/session-catalog/catalog.mjs",
    sourcePath: fileURLToPath(new URL("./catalog.mjs", import.meta.url)),
  }),
]);

export const patches = Object.freeze([
  patch("dist/core/session-manager.js", "046b6a1109ac3f0ed893bb85bf0648709362fa926a5da75761216cf2fcf9d926", patchSessionManagerRuntime),
  patch("dist/core/session-manager.d.ts", "2288b69c82272311dc877da61ff2057bb04df49038ddef7eef6c8753c09f5313", patchSessionManagerTypes),
]);

export const feature = Object.freeze({ id: "session-catalog", patches, files });
