import { delimiter } from "node:path"

/**
 * Extension entry paths a memory child must load even though it runs `--no-extensions`.
 *
 * `--no-extensions` disables extension DISCOVERY only; senpi still loads paths passed explicitly as
 * `-e`/`--extension` (verified in senpi core/resource-loader.js, where `noExtensions` selects
 * `cliEnabledExtensions` instead of merging the discovered set). That distinction is what makes this
 * fix possible: the child keeps its lean, isolated boot and still gets the providers it needs.
 *
 * The motivating failure: a host whose model providers are registered at runtime BY an extension
 * (rubato's broker overlay, which points every model at a local bridge) leaves nothing in the
 * on-disk provider config. A discovery-disabled child therefore booted with only pi-ai's builtin
 * providers — visible in `--list-models`, so model preflight passed — and then called the vendor API
 * directly with no credential. Every reflection, dream, and facts run died on HTTP 401 while the
 * parent session, which had the overlay loaded, worked fine.
 *
 * The host names those extensions in `RUBATO_MEMORY_CHILD_EXTENSIONS` (a PATH-style delimited list of
 * absolute module paths). Unset or empty means today's argv exactly, so a host that keeps its
 * providers in config — the upstream shape — is unaffected.
 *
 * Only provider-carrying extensions belong here. Forwarding the host's whole `-e` list would drag
 * the Rubato/lead/adapter overlays into the child and undo the isolation `--no-extensions` buys; the
 * child would re-register tools, statuslines, and task engines it must not have.
 */
export const MEMORY_CHILD_EXTENSIONS_ENV = "RUBATO_MEMORY_CHILD_EXTENSIONS"

export function memoryChildExtensionPaths(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = env[MEMORY_CHILD_EXTENSIONS_ENV]
  if (raw === undefined) return []
  const seen = new Set<string>()
  for (const entry of raw.split(delimiter)) {
    const path = entry.trim()
    if (path.length > 0) seen.add(path)
  }
  return [...seen]
}

/** `-e <path>` pairs to splice into a discovery-disabled child's argv. */
export function memoryChildExtensionArgs(env: NodeJS.ProcessEnv): readonly string[] {
  return memoryChildExtensionPaths(env).flatMap((path) => ["-e", path])
}
