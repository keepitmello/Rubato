import type {
  RubatoAgentDef,
  RubatoAgentModelEntry,
  RubatoConfig,
  RubatoFallbackModelObject,
  RubatoModelCatalog,
  RubatoModelCatalogEntry,
  RubatoReasoning,
} from "../schema"
import { findModelCatalogCycles } from "./model-catalog-cycles"

export type RubatoModelReferenceDiagnostic = {
  readonly kind: "model_catalog_cycle"
  readonly message: string
  readonly path: string
}

export type ResolveModelReferencesResult = {
  readonly diagnostics: readonly RubatoModelReferenceDiagnostic[]
  readonly view: RubatoConfig
}

function catalogReference(
  model: string,
  reasoning: RubatoReasoning | undefined,
  catalog: RubatoModelCatalog | undefined,
  cycleNames: ReadonlySet<string>,
): RubatoModelCatalogEntry | undefined {
  const entry = catalog?.[model]
  if (entry === undefined || cycleNames.has(model)) return undefined

  return {
    model: entry.model,
    ...(reasoning === undefined && entry.reasoning !== undefined
      ? { reasoning: entry.reasoning }
      : reasoning !== undefined ? { reasoning } : {}),
  }
}

function resolveModelEntry(
  entry: RubatoAgentModelEntry | string | RubatoFallbackModelObject,
  catalog: RubatoModelCatalog | undefined,
  cycleNames: ReadonlySet<string>,
): RubatoAgentModelEntry {
  if (typeof entry === "string") {
    const resolved = catalogReference(entry, undefined, catalog, cycleNames)
    if (resolved === undefined) return entry
    return resolved.reasoning === undefined ? resolved.model : resolved
  }

  const resolved = catalogReference(entry.model, entry.reasoning, catalog, cycleNames)
  if (resolved === undefined) return entry
  return {
    ...entry,
    model: resolved.model,
    ...(entry.reasoning === undefined && resolved.reasoning !== undefined ? { reasoning: resolved.reasoning } : {}),
  }
}

function resolveAgentDefinition(
  definition: RubatoAgentDef,
  catalog: RubatoModelCatalog | undefined,
  cycleNames: ReadonlySet<string>,
): RubatoAgentDef {
  const resolvedModel = definition.model === undefined
    ? undefined
    : catalogReference(definition.model, definition.reasoning, catalog, cycleNames)

  return {
    ...definition,
    ...(resolvedModel === undefined ? {} : { model: resolvedModel.model }),
    ...(definition.reasoning === undefined && resolvedModel?.reasoning !== undefined
      ? { reasoning: resolvedModel.reasoning }
      : {}),
    ...(definition.models === undefined
      ? {}
      : { models: definition.models.map((entry) => resolveModelEntry(entry, catalog, cycleNames)) }),
  }
}

function cycleDiagnostics(catalog: RubatoModelCatalog | undefined): readonly RubatoModelReferenceDiagnostic[] {
  if (catalog === undefined) return []
  return findModelCatalogCycles(catalog).map((name) => ({
    kind: "model_catalog_cycle",
    message: catalog[name]?.model === name
      ? `Model catalog entry "${name}" references itself`
      : `Model catalog entry "${name}" participates in a reference cycle`,
    path: `models.${name}.model`,
  }))
}

export function resolveModelReferences(view: RubatoConfig): ResolveModelReferencesResult {
  const diagnostics = cycleDiagnostics(view.models)
  const cycleNames = new Set<string>()
  for (const diagnostic of diagnostics) {
    const name = diagnostic.path.split(".")[1]
    if (name !== undefined) cycleNames.add(name)
  }
  const agents = view.agents === undefined
    ? undefined
    : Object.fromEntries(Object.entries(view.agents).map(([name, definition]) => [
      name,
      resolveAgentDefinition(definition, view.models, cycleNames),
    ]))

  return {
    diagnostics,
    view: {
      ...view,
      ...(agents === undefined ? {} : { agents }),
    },
  }
}
