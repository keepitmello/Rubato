import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_VERSION = "0.86.1";
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
  next = replaceOnce(
    next,
    `        const hasAssistant = this.fileEntries.some((e) => e.type === "message" && e.message.role === "assistant");
        if (!hasAssistant) {`,
    `        const hasMessage = this.fileEntries.some((e) => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"));
        if (!hasMessage) {`,
    "persist-first-user",
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
  patch("dist/core/session-manager.js", "96bd76b298f3c0a6b6d9b57b727f0f9b1196fbfa83172071ac280a5a37f82a08", patchSessionManagerRuntime),
  patch("dist/core/session-manager.d.ts", "4b39381623569d0ad6684a170966a092a078ef97359f6e9e7d215273655d15c8", patchSessionManagerTypes),
]);

export const feature = Object.freeze({ id: "session-catalog", patches, files });
