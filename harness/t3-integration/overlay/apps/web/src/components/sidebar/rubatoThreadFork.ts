import {
  ThreadId,
  type ContextMenuItem,
  type EnvironmentId,
  type ModelSelection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShell } from "~/state/entities";
import { rubatoHttpAccess } from "~/state/rubatoHttp";
import { environmentServerConfigsAtom } from "~/state/server";
import { readPreparedConnection } from "~/state/session";
import { environmentThreadShells } from "~/state/threads";

// "Fork thread" in the sidebar's thread menu (the thread action menu and the legacy
// sidebar's). The server half is /rubato/thread-fork (RubatoThreadFork.ts): it copies
// the thread's Rubato conversation into a new one and answers with the thread that shows it.

const FORK_ROUTE = "/rubato/thread-fork";

function rubatoDriverOf(environmentId: EnvironmentId, instanceId: string): boolean {
  const providers = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.providers ?? [];
  return providers.some((provider) => provider.instanceId === instanceId && provider.driver === "rubato-pi");
}

type ForkableThread = { readonly environmentId: EnvironmentId; readonly modelSelection: ModelSelection };

/** Fork is offered for a thread that runs on Rubato; other providers keep their own history. */
export function threadRunsOnRubato(
  thread: ForkableThread,
  runsOnRubato: (environmentId: EnvironmentId, instanceId: string) => boolean = rubatoDriverOf,
): boolean {
  return runsOnRubato(thread.environmentId, thread.modelSelection.instanceId);
}

export function forkMenuItems(
  thread: ForkableThread,
  runsOnRubato: (environmentId: EnvironmentId, instanceId: string) => boolean = rubatoDriverOf,
): ContextMenuItem<"fork">[] {
  return threadRunsOnRubato(thread, runsOnRubato) ? [{ id: "fork", label: "Fork thread" }] : [];
}

/** Resolves when the thread reaches the live client store; the route sends a missing thread home. */
function waitForThreadShell(ref: ScopedThreadRef, timeoutMs = 10_000): Promise<void> {
  if (readThreadShell(ref) !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      unsubscribe?.();
      reject(new Error("The fork was made, but its thread did not appear in the app."));
    }, timeoutMs);
    const finish = (shell: unknown) => {
      if (shell === null) return;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve();
    };
    unsubscribe = appAtomRegistry.subscribe(environmentThreadShells.threadShellAtom(ref), finish);
    finish(readThreadShell(ref));
  });
}

/** Forks the thread and answers with the new thread once the app can open it. */
export async function forkThread(ref: ScopedThreadRef): Promise<ScopedThreadRef> {
  const prepared = readPreparedConnection(ref.environmentId);
  if (!prepared) throw new Error("This Mac is not connected.");
  const access = await rubatoHttpAccess(prepared);
  if (!access) throw new Error("Forking is not available on this connection.");
  const response = await fetch(`${access.baseUrl}${FORK_ROUTE}`, {
    method: "POST",
    credentials: access.credentials,
    headers: { ...access.headers, "content-type": "application/json" },
    body: JSON.stringify({ threadId: ref.threadId }),
  });
  const payload = (await response.json().catch(() => null)) as
    | { threadId?: string; error?: { message?: string } }
    | null;
  if (!response.ok || !payload?.threadId) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  const forked = scopeThreadRef(ref.environmentId, ThreadId.make(payload.threadId));
  await waitForThreadShell(forked);
  return forked;
}
