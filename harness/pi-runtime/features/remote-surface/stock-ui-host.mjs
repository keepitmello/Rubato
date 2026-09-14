import { randomUUID } from 'node:crypto';

// A per-binding capability, not a process-global current-session pointer. An old
// extension must never acquire the replacement session's writer through this port.
export const STOCK_UI_HOST = Symbol.for('rubato.stock-ui-host.v1');
const bindings = new WeakMap();

export function resetStockUiHost(mode) { bindings.get(mode)?.deactivate(); }

export function invalidateStockUiHost(mode) {
  bindings.get(mode)?.dispose();
  bindings.delete(mode);
}

/** Bind to the existing TUI; do not create another AgentSession or renderer. */
export function bindStockUiHost(mode, ui, options = {}) {
  invalidateStockUiHost(mode);
  let session = mode.session;
  let active = true;
  let emit;
  let wrapped = false;
  let claim;
  let pending;
  const disposers = new Set();
  const originals = new Map();
  const assertActive = () => {
    if (!active || mode.session !== session) throw new Error('Stock interactive control belongs to a stale session binding');
  };
  const dismiss = (request) => {
    if (pending !== request) return;
    pending = undefined;
    emit?.('interactive.ui.dismiss', { requestId: request.data.requestId });
  };
  const cancel = () => {
    const request = pending;
    if (!request) return;
    // Use the real dialog callback so its promise, timeout and abort listener
    // are settled through the same path as terminal Escape.
    if (mode[request.slot] === request.component) request.component.onCancelCallback();
    dismiss(request);
  };
  const port = {
    env: options.env ?? process.env,
    hosted: Boolean(options.onClose),
    get active() { return active; },
    run(fn) { assertActive(); return options.run ? options.run(fn) : fn(); },
    onClose: options.onClose,
    onDispose(fn) { disposers.add(fn); return () => disposers.delete(fn); },
    deactivate() {
      cancel();
      claim = undefined;
      emit = undefined;
      for (const [kind, original] of originals) ui[kind] = original;
      originals.clear();
      wrapped = false;
    },
    executeUserBash(command, excluded) { assertActive(); return mode.handleBashCommand(command, excluded); },
    abortUserBash() { assertActive(); return session.abortBash(); },
    get uiRequest() {
      assertActive();
      if (pending && mode[pending.slot] !== pending.component) dismiss(pending);
      return pending ? structuredClone(pending.data) : undefined;
    },
    respond(requestId, value) {
      assertActive();
      const request = pending;
      if (!request || request.data.requestId !== requestId || mode[request.slot] !== request.component) return false;
      const { kind, options } = request.data;
      if (value !== undefined && value !== null) {
        if (kind === 'confirm' ? typeof value !== 'boolean' : typeof value !== 'string') return false;
        if (kind === 'select' && !options.includes(value)) return false;
      }
      // Clear before invoking callbacks: duplicate/late replies cannot win a
      // race with a terminal answer, timeout or replacement dialog.
      dismiss(request);
      if (value === undefined || value === null) request.component.onCancelCallback();
      else if (kind === 'input') request.component.onSubmitCallback(value);
      else request.component.onSelectCallback(kind === 'confirm' ? value ? 'Yes' : 'No' : value);
      return true;
    },
    activate(listener) {
      assertActive();
      cancel();
      emit = listener;
      const token = claim = Symbol();
      const runner = session.extensionRunner;
      const assertBinding = () => {
        assertActive();
        if (claim !== token || session.extensionRunner !== runner) throw new Error('Stock interactive control belongs to a stale extension binding');
      };
      const guarded = (fn) => (...args) => { assertBinding(); return fn(...args); };
      if (!wrapped) for (const kind of ['select', 'confirm', 'input']) {
        const original = ui[kind];
        originals.set(kind, original);
        ui[kind] = (...args) => {
          assertActive();
          cancel();
          const result = original(...args);
          const slot = kind === 'input' ? 'extensionInput' : 'extensionSelector';
          const component = mode[slot];
          // Pre-aborted requests create no dialog and must not be advertised.
          if (!component) return result;
          const data = { requestId: randomUUID(), kind, title: args[0],
            ...(kind === 'select' ? { options: [...args[1]] }
              : kind === 'confirm' ? { message: args[1] } : { placeholder: args[1] }) };
          const request = { data, slot, component };
          pending = request;
          emit('interactive.ui.request', structuredClone(data));
          return Promise.resolve(result).finally(() => dismiss(request));
        };
      }
      wrapped = true;
      return {
        get session() { assertBinding(); return session; },
        get uiRequest() { assertBinding(); return port.uiRequest; },
        commandContext: guarded(() => runner.createCommandContext()),
        executeUserBash: guarded(port.executeUserBash),
        abortUserBash: guarded(port.abortUserBash),
        respond: guarded(port.respond),
      };
    },
    dispose() {
      port.deactivate(); active = false;
      for (const fn of disposers) fn();
      disposers.clear();
      // Stale capabilities still fail closed, but must not keep a detached
      // renderer/session alive just because an extension retained its old UI.
      mode = undefined; ui = undefined; session = undefined;
    },
  };
  // ExtensionRunner wraps UI with an object spread; enumerable symbols survive
  // that wrapper without adding a user-facing string method to ExtensionUI.
  Object.defineProperty(ui, STOCK_UI_HOST, { value: port, enumerable: true });
  bindings.set(mode, port);
  return ui;
}
