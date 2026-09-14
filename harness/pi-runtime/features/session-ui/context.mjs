import { AsyncLocalStorage } from 'node:async_hooks';
import nodeProcess from 'node:process';
import { format } from 'node:util';

const current = new AsyncLocalStorage();
const createState = () => ({ registeredThemes: new Map(), cellDimensions: { widthPx: 9, heightPx: 18 },
  cachedCapabilities: null, capabilityOverrides: {}, globalKeybindings: null,
  _kittyProtocolActive: false, _lastEventType: 'press', kittyTransmissionGeneration: 0,
  rawStdoutWriteTail: Promise.resolve(),
  trackedDetachedChildPids: new Set(), commandResultCache: new Map() });
const standalone = createState();

/** One presentation's ambient state. SDK actors and the process are not owned here. */
export function createUiScope({ process: presentationProcess, env = nodeProcess.env, edit } = {}) {
  const closeHandlers = new Set();
  const scope = { state: createState(), process: presentationProcess, env, edit,
    closed: false,
    onClose(fn) {
      if (scope.closed) queueMicrotask(scope.bind(fn)); else closeHandlers.add(fn);
      return () => closeHandlers.delete(fn);
    },
    close() {
      if (scope.closed) return;
      scope.closed = true;
      scope.run(() => { for (const fn of closeHandlers) fn(); });
      closeHandlers.clear();
    },
    assertOpen() { if (scope.closed) throw new PresentationExit(0); },
    run(fn, ...args) { return current.run(scope, fn, ...args); },
    bind(fn) { return function(...args) { return scope.run(() => Reflect.apply(fn, this, args)); }; },
  };
  return scope;
}
export const uiScope = () => current.getStore();
export const uiState = () => uiScope()?.state ?? standalone;
export function outsideUi(fn) { return current.run(undefined, fn); }
export class PresentationExit extends Error {
  constructor(code) { super(`Presentation exited (${code})`); this.code = code; }
}
export function exitUiProcess(code = 0) {
  if (uiScope()) throw new PresentationExit(code);
  nodeProcess.exit(code);
}
export function bindUiCallback(fn) { return uiScope()?.bind(fn) ?? fn; }
const contextPorts = new WeakMap();
const rememberedUi = new Set(['setStatus', 'setWidget', 'setFooter', 'setHeader', 'setEditorComponent']);
export function bindUiContext(context, previous) {
  const scope = uiScope();
  if (!scope || !context) return context;
  const existing = previous && contextPorts.get(previous);
  if (existing) {
    existing.context = context; existing.scope = scope;
    scope.run(() => { for (const [method, args] of existing.state.values()) context[method]?.(...args); });
    return previous;
  }
  const port = { context, scope, state: new Map() };
  const functions = new Map();
  const proxy = new Proxy({}, { get(_target, key) {
    const target = port.context;
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    if (!functions.has(key)) functions.set(key, (...args) => {
      if (rememberedUi.has(key)) {
        const keyed = key === 'setStatus' || key === 'setWidget';
        const id = keyed ? `${key}:${args[0]}` : key;
        if (args[keyed ? 1 : 0] === undefined) port.state.delete(id);
        else port.state.set(id, [key, args]);
      }
      return port.scope.run(() => Reflect.apply(port.context[key], port.context, args));
    });
    return functions.get(key);
  }, has: (_target, key) => key in port.context,
    ownKeys: () => Reflect.ownKeys(port.context),
    getOwnPropertyDescriptor: (_target, key) => key in port.context ? { configurable: true, enumerable: true, value: proxy[key] } : undefined,
  });
  contextPorts.set(proxy, port);
  return proxy;
}
// Only UI-owned modules import this facade. Never replace process globals or
// monkey-patch Node for the entire engine. Standalone behavior is unchanged.
export const uiProcess = new Proxy(nodeProcess, { get(target, key) {
  const scope = uiScope();
  if (key === 'env' && scope) return scope.env;
  const owner = scope?.process && key in scope.process ? scope.process : target;
  const value = Reflect.get(owner, key, owner);
  return typeof value === 'function' ? value.bind(owner) : value;
}, set(target, key, value) {
  const owner = uiScope()?.process ?? target;
  return Reflect.set(owner, key, value, owner);
} });
export const uiConsole = new Proxy(console, { get(target, key) {
  if (uiScope()?.process && ['log', 'info', 'warn', 'error', 'debug'].includes(key)) {
    return (...args) => uiProcess[key === 'warn' || key === 'error' ? 'stderr' : 'stdout'].write(format(...args) + '\n');
  }
  const value = Reflect.get(target, key, target);
  return typeof value === 'function' ? value.bind(target) : value;
} });
