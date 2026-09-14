import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionClient } from './client.mjs';

async function abortAndInvalidate(session, invalidate) {
  const pending = session.abort();
  // An extension tool can await a native dialog without forwarding its abort
  // signal. Dismiss that UI before awaiting idle, or both wait on each other.
  try { invalidate?.(); } finally { await pending; }
}

/** A native CLI's selection cursor, NOT an SDK runtime owner. Every acquisition
 * still travels through the official server/router, just like GUI attachment.
 * Native new/resume/fork/import policy and callbacks remain in Pi's runtime.
 */
export async function createSessionCursor({ host, descriptor, api, createRuntime, initial, scope }) {
  const owner = randomUUID();
  let selected, transition, disposed;
  const release = async (entry, { abort = false, invalidate } = {}) => {
    if (!entry) return;
    try {
      if (abort) await abortAndInvalidate(entry.worker.runtime.session, invalidate);
      else invalidate?.();
      await api.outsideUi(() => entry.worker.controller.activatePresentation());
    } finally {
      entry.releaseClaim();
      await entry.client.close();
    }
  };
  const acquire = async request => {
    scope.assertOpen();
    const manager = request.sessionManager;
    let file = manager.getSessionFile();
    if (file) {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      try {
        // Publish public entries, then let Pi reopen its own file. Merely writing
        // a header leaves a freshly-created manager unflushed: its first prompt
        // would correctly fail the SDK's exclusive-create guard with EEXIST.
        const entries = [manager.getHeader(), ...manager.getEntries()];
        await writeFile(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
        manager.setSessionFile(file);
      }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      file = await realpath(file);
    }
    const metadata = { id: manager.getSessionId(), cwd: manager.getCwd(), file: file ?? null };
    if (selected?.worker.metadata.id === metadata.id) {
      if (selected.worker.metadata.file !== metadata.file) throw new Error('Session ID already belongs to a different file');
      await abortAndInvalidate(selected.worker.runtime.session, transition?.invalidate);
      transition = undefined;
      return selected.worker.runtime;
    }
    const releaseClaim = host.claimPresentation(metadata.id, owner);
    const client = new SessionClient(descriptor);
    let unprepare;
    let next;
    try {
      unprepare = await host.prepareSession(metadata, {
        // Explicit context: sockets must not inherit whichever CLI happened to
        // create the shared server. Trust prompts belong to this presentation.
        createRuntime: () => scope.run(() => api.createAgentSessionRuntime(createRuntime, request)),
        env: { ...scope.env },
        deferSessionStart: true,
      });
      await api.outsideUi(async () => { await client.connect(); await client.attach(metadata.id); });
      scope.assertOpen();
      const worker = host.getSessionWorker(metadata.id);
      if (!worker?.runtime || !worker.controller?.activatePresentation) throw new Error('Engine does not support native CLI attachments');
      next = { client, worker, releaseClaim };
    } catch (error) {
      releaseClaim(); await client.close().catch(() => {}); throw error;
    } finally { unprepare?.(); }
    try { await release(selected, { abort: true, invalidate: transition?.invalidate }); }
    catch (error) { await release(next); throw error; }
    selected = next; transition = undefined;
    return next.worker.runtime;
  };
  const result = await acquire(initial);
  const cursor = new api.AgentSessionRuntime(result.session, result.services, acquire, result.diagnostics, result.modelFallbackMessage, {
    // Acquire the target before touching the old actor. A busy/missing target
    // leaves the old presentation and its SDK writer intact.
    beforeSwitch(info) { transition = info; },
    beforeImport(file) { return host.resolveImport(file); },
    dispose(invalidate) {
      return disposed ??= (async () => { const entry = selected; selected = undefined; await release(entry, { abort: true, invalidate }); })();
    },
  });
  return cursor;
}
