// Source-tree shim. The build stages the real module from packages/model-core into this
// directory (see patches.mjs `files`), so the import specifier is identical either way.
export * from "../../../../packages/model-core/src/model-label.mjs";
