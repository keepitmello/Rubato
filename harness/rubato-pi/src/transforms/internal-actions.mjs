// In-repo copy of senpi `internal-actions.js` (baseline new file).
// A load transform cannot create that module, so importers are rewritten to this href.
const INTERNAL_ACTION_PREFIX = "senpi-action:";
const actions = new Map();
let nextActionId = 0;

export function internalActionsHref() {
  return import.meta.url;
}

export function registerInternalAction(action) {
  const url = `${INTERNAL_ACTION_PREFIX}${++nextActionId}`;
  actions.set(url, action);
  return {
    url,
    dispose() {
      actions.delete(url);
    },
  };
}

export function dispatchInternalAction(url) {
  if (!url.startsWith(INTERNAL_ACTION_PREFIX)) return false;
  actions.get(url)?.();
  return true;
}
