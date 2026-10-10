// Source-tree shim. The staged product-model-catalog.mjs imports ./model-label.mjs, so the
// build stages the real module from packages/model-core next to it (see patches.mjs `files`).
export * from "../../../../../../packages/model-core/src/model-label.mjs";
