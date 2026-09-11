import { basename, extname } from "node:path";

import { buildBm25Index } from "./bm25.mjs";
import { deriveExtensionRegistrationId, rehydrate } from "./marker.mjs";
import { TOOL_SEARCH_TOOL_NAME } from "./tool.mjs";

/** Session-owned catalog. Feed owners retain activation and lifecycle authority. */
export class ToolSearchService {
  #runtime;
  #feeds = new Map();
  #extensionDocs = [];
  #extensionFingerprint = "";
  #generation = 0;
  #historyGeneration = -1;
  #history = [];
  #registerToolSearch;

  constructor(runtime) {
    if (runtime) this.bindRuntime(runtime);
  }

  bindRuntime(runtime) {
    this.#runtime = runtime;
    this.#feeds.set("extension", {
      docs: this.#extensionDocs,
      hooks: { activate: (names) => this.#promote(names) },
    });
  }

  bindToolRegistrar(register) {
    this.#registerToolSearch = register;
  }

  beginSession(messages = []) {
    this.#requireRuntime();
    this.#history = messages;
    this.#feeds.delete("mcp");
    this.#generation += 1;
    this.#historyGeneration = -1;
    this.#refreshExtensionDocs();
    this.#syncLifecycle();
    return this.maybeRehydrateFromHistory(messages);
  }

  feed(source, docs, hooks) {
    if (source !== "mcp" && source !== "extension") throw new TypeError(`Unknown tool-search source '${source}'`);
    const valid = docs.filter((doc) => doc?.source === source && doc.name && doc.registrationId);
    this.#feeds.set(source, { docs: valid, hooks });
    this.#generation += 1;
    this.#syncLifecycle();
    return this.maybeRehydrateFromHistory(this.#history);
  }

  clearFeed(source) {
    if (!this.#feeds.delete(source)) return;
    this.#generation += 1;
    this.#historyGeneration = -1;
    this.#syncLifecycle();
  }

  getCatalog() {
    this.#requireRuntime();
    this.#refreshExtensionDocs();
    return [...(this.#feeds.get("mcp")?.docs ?? []), ...this.#extensionDocs];
  }

  search(query, limit = 10, options = {}) {
    return buildBm25Index(this.getCatalog()).search(query, limit, options);
  }

  activate(matches) {
    const bySource = new Map();
    for (const match of matches) {
      const names = bySource.get(match.doc.source) ?? [];
      names.push(match.name);
      bySource.set(match.doc.source, names);
    }
    for (const [source, names] of bySource) this.#feeds.get(source)?.hooks.activate(names);
    const active = new Set(this.#runtime.getActiveTools());
    return matches.map(({ name }) => name).filter((name) => active.has(name));
  }

  activateTool(name) {
    const doc = this.getCatalog().find((candidate) => candidate.name === name);
    if (!doc || doc.allowLazyActivation === false) return false;
    this.#feeds.get(doc.source)?.hooks.activate([name]);
    return this.#runtime.getActiveTools().includes(name);
  }

  maybeRehydrateFromHistory(messages = this.#history) {
    const catalog = this.getCatalog();
    if (this.#historyGeneration === this.#generation) return [];
    this.#historyGeneration = this.#generation;
    const docsByName = new Map(catalog.map((doc) => [doc.name, {
      name: doc.name,
      registrationId: doc.registrationId,
      source: doc.source,
      allowLazyActivation: doc.allowLazyActivation !== false,
    }]));
    const restored = rehydrate(messages, docsByName);
    if (restored.length > 0) {
      const byName = new Map(catalog.map((doc) => [doc.name, doc]));
      this.activate(restored.map((name) => ({ name, doc: byName.get(name) })).filter(({ doc }) => doc));
    }
    return restored;
  }

  #refreshExtensionDocs() {
    const docs = this.#runtime.getAllTools()
      .filter((tool) => tool.exposure === "search" && tool.allowLazyActivation !== false)
      .map(extensionDocument)
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name));
    const fingerprint = JSON.stringify(docs);
    if (fingerprint === this.#extensionFingerprint) return;
    this.#extensionDocs = docs;
    this.#extensionFingerprint = fingerprint;
    this.#feeds.set("extension", { docs, hooks: { activate: (names) => this.#promote(names) } });
    this.#generation += 1;
  }

  #syncLifecycle() {
    if (!this.#runtime) return;
    const hasDocuments = this.#extensionDocs.length > 0 || (this.#feeds.get("mcp")?.docs.length ?? 0) > 0;
    if (hasDocuments) this.#registerToolSearch?.();
    const current = this.#runtime.getActiveTools();
    const active = current.includes(TOOL_SEARCH_TOOL_NAME);
    if (hasDocuments !== active) {
      this.#runtime.setActiveTools(hasDocuments
        ? [...current, TOOL_SEARCH_TOOL_NAME]
        : current.filter((name) => name !== TOOL_SEARCH_TOOL_NAME));
    }
  }

  #promote(names) {
    const current = this.#runtime.getActiveTools();
    const active = new Set(current);
    const added = [...new Set(names.filter((name) => !active.has(name)))].sort();
    if (added.length > 0) this.#runtime.setActiveTools([...current, ...added]);
  }

  #requireRuntime() {
    if (!this.#runtime) throw new Error("ToolSearchService runtime is not bound");
  }
}

function extensionDocument(tool) {
  const fileName = basename(tool.sourceInfo.path);
  const extension = extname(fileName);
  const ownerLabel = extension ? fileName.slice(0, -extension.length) : fileName;
  return {
    name: tool.name,
    label: tool.label,
    aliases: [],
    description: tool.description,
    searchText: tool.searchText,
    keywords: [...tool.searchKeywords],
    source: "extension",
    group: tool.searchGroup ?? ownerLabel,
    ownerLabel,
    registrationId: deriveExtensionRegistrationId(tool.sourceInfo, tool.name),
    allowLazyActivation: tool.allowLazyActivation,
  };
}
