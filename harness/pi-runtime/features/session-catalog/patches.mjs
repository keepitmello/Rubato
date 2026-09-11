import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_VERSION = "0.85.1";
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
    `    static async listAll(sessionDirOrOnProgress, onProgress) {`,
    `    static async listPage(cwd, sessionDir, onProgress, page = {}) {
        const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
        const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
        const resolvedCwd = resolvePath(cwd);
        return listSessionCatalogPage({
            root: dir,
            readHeader: readSessionHeaderForDiscovery,
            acceptHeader: (header) => !filterCwd || sessionCwdMatches(getSessionHeaderCwd(header), resolvedCwd),
            buildInfo: buildSessionInfo,
            onProgress,
            page,
        });
    }
    static async listAllPage(sessionDirOrOnProgress, onProgress, page = {}) {
        const customSessionDir = typeof sessionDirOrOnProgress === "string" ? normalizePath(sessionDirOrOnProgress) : undefined;
        const progress = typeof sessionDirOrOnProgress === "function" ? sessionDirOrOnProgress : onProgress;
        const effectivePage = typeof sessionDirOrOnProgress === "function"
            ? (onProgress && typeof onProgress === "object" ? onProgress : page)
            : page;
        return listSessionCatalogPage({
            root: customSessionDir ?? getSessionsDir(),
            includeSubdirectories: customSessionDir === undefined,
            readHeader: readSessionHeaderForDiscovery,
            buildInfo: buildSessionInfo,
            onProgress: progress,
            page: effectivePage,
        });
    }
    static async listAll(sessionDirOrOnProgress, onProgress) {`,
    "paged-api",
  );
  return next;
}

function patchSessionManagerTypes(source) {
  unpatched(source, "export interface SessionListPageResult", "session-manager-types");
  let next = replaceOnce(
    source,
    `export type SessionListProgress = (loaded: number, total: number) => void;`,
    `export type SessionListProgress = (loaded: number, total: number) => void;
export interface SessionListPageOptions {
    offset?: number;
    limit?: number;
    query?: string;
}
export interface SessionListPageResult {
    sessions: SessionInfo[];
    total: number;
    offset: number;
    hasMore: boolean;
}`,
    "page-types",
  );
  next = replaceOnce(
    next,
    `    static list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
    /**
     * List all sessions across all project directories.`,
    `    static list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
    static listPage(cwd: string, sessionDir?: string, onProgress?: SessionListProgress, page?: SessionListPageOptions): Promise<SessionListPageResult>;
    static listAllPage(onProgress?: SessionListProgress, page?: SessionListPageOptions): Promise<SessionListPageResult>;
    static listAllPage(sessionDir?: string, onProgress?: SessionListProgress, page?: SessionListPageOptions): Promise<SessionListPageResult>;
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
  patch("dist/core/session-manager.js", "ccace64949db25379a43971ecea750c1b7ec6344e1bc31b9d5fe596ac2f1c9f3", patchSessionManagerRuntime),
  patch("dist/core/session-manager.d.ts", "b349557f08b25c8655b041ee05d27ff824ffd7c805531ddb460d46b62e4445f7", patchSessionManagerTypes),
]);

export const feature = Object.freeze({ id: "session-catalog", patches, files });
