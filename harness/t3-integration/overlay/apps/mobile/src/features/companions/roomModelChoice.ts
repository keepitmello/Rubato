// The room header's model menu (intent companion-agy-parity): a pick switches the companion now,
// as the desktop room's picker does (server RubatoCompanionModel.ts). It offers the Rubato engine that
// owns the room's thread and the Gemini accounts the Add flow offers; the thread stays with its engine.
// The phone cannot read the session's current model, so only the pick this room applied is ticked.
import type { ServerProvider, ServerSettings } from "@t3tools/contracts";
import {
  companionModelAccounts,
  type CompanionModelSelection,
} from "@t3tools/shared/rubatoCompanionModelChoice";

import type { AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar.types";

const RUBATO_DRIVER = "rubato-pi";
/** The engine's private route for a Gemini companion; the engine refuses it as a pick (hosted-runtime.mjs). */
const COMPANION_AGY_ROUTE = "rubato-companion-acp";

type ProviderSnapshot = Pick<
  ServerProvider,
  "instanceId" | "driver" | "enabled" | "installed" | "status" | "availability" | "displayName"
> & {
  readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string; readonly subProvider?: string | undefined }>;
};

export interface RoomModelLabels {
  readonly menu: string;
  readonly rubato: string;
  readonly gemini: (account: string) => string;
  readonly defaultModel: string;
}

export interface RoomModelMenuInput {
  readonly providers: ReadonlyArray<ProviderSnapshot>;
  readonly instances: ServerSettings["providerInstances"] | undefined;
  /** The provider instance that carries the room's thread (its modelSelection.instanceId). */
  readonly owner: string | null;
  /** The pick this room applied last; null when it applied none. */
  readonly applied: CompanionModelSelection | null;
  /** While a pick is on its way, nothing else can be picked. */
  readonly busy: boolean;
  readonly labels: RoomModelLabels;
  readonly onPick: (selection: CompanionModelSelection) => void;
}

const usable = (provider: ProviderSnapshot) =>
  provider.enabled &&
  provider.installed !== false &&
  (provider.status === "ready" || provider.status === "warning") &&
  provider.availability !== "unavailable";

const subProviderOf = (model: ProviderSnapshot["models"][number]) =>
  model.subProvider?.trim() || (model.slug.includes("/") ? model.slug.slice(0, model.slug.indexOf("/")) : "");

const same = (a: CompanionModelSelection | null, b: CompanionModelSelection) =>
  a !== null && a.instanceId === b.instanceId && a.model === b.model;

/** The models of the engine that owns the thread, one group per sub-provider in catalog order. */
function rubatoGroups(input: RoomModelMenuInput): ReadonlyArray<{
  readonly name: string;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
}> {
  if (input.owner === null) return [];
  const engine = input.providers.find(
    (provider) => provider.instanceId === input.owner && provider.driver === RUBATO_DRIVER,
  );
  if (!engine || !usable(engine)) return [];
  const groups = new Map<string, Array<{ readonly slug: string; readonly name: string }>>();
  for (const model of engine.models) {
    const name = subProviderOf(model);
    // A Rubato model is "provider/modelId"; the engine refuses anything else, and its Gemini route.
    if (!name || !model.slug.includes("/") || name.startsWith(COMPANION_AGY_ROUTE)) continue;
    const group = groups.get(name) ?? [];
    group.push({ slug: model.slug, name: model.name });
    groups.set(name, group);
  }
  return [...groups].map(([name, models]) => ({ name, models }));
}

/**
 * The room's model menu, or null when the Mac offers nothing to switch to (its engine is not
 * running and no Antigravity account qualifies).
 */
export function roomModelMenu(input: RoomModelMenuInput): AppBarMenu | null {
  const action = (selection: CompanionModelSelection, title: string, subtitle?: string): AppBarMenuItem => ({
    id: `${selection.instanceId}\u0000${selection.model}`,
    title,
    ...(subtitle ? { subtitle } : {}),
    selected: same(input.applied, selection),
    disabled: input.busy,
    onPress: () => input.onPick(selection),
  });
  const items: AppBarMenuItem[] = [];
  const engine = input.owner;
  const groups = rubatoGroups(input);
  if (engine !== null && groups.length > 0) {
    const rows = (models: ReadonlyArray<{ readonly slug: string; readonly name: string }>) =>
      models.map((model) => action({ instanceId: engine, model: model.slug }, model.name));
    items.push({
      id: `rubato:${engine}`,
      title: input.labels.rubato,
      items:
        groups.length === 1
          ? rows(groups[0]!.models)
          : groups.map((group) => ({ id: `rubato:${engine}:${group.name}`, title: group.name, items: rows(group.models) })),
    });
  }
  for (const account of companionModelAccounts(input.providers, input.instances)) {
    items.push({
      id: `gemini:${account.instanceId}`,
      title: input.labels.gemini(account.label),
      items: account.models.map((model) =>
        action(
          { instanceId: account.instanceId, model: model.slug },
          model.name,
          model.slug === account.defaultModel ? input.labels.defaultModel : undefined,
        ),
      ),
    });
  }
  if (items.length === 0) return null;
  return { title: input.labels.menu, icon: { ios: "brain", android: "psychology" }, items };
}

/** The body of POST /rubato/companion-room/model: the two routing fields and nothing else. */
export function roomModelRequest(
  threadId: string,
  selection: CompanionModelSelection,
): { readonly threadId: string; readonly modelSelection: CompanionModelSelection } {
  return { threadId, modelSelection: { instanceId: selection.instanceId, model: selection.model } };
}
