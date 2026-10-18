// Settings > Providers. T3's page configures T3's own drivers (binaries, homes,
// env vars), none of which Rubato uses: every model goes through the one Rubato
// instance, and what decides whether a model works is `rubato auth`. The page
// is ours instead: connection state and sign-in per provider, plus the model
// visibility switch that was the one T3 setting worth keeping. The route keeps
// its search params so T3's links to it (with environmentId/instanceId) still land.
export const providerOverlays = [
  // Also serves Settings > General > About (/rubato/app); about-edits.mjs holds its page.
  'apps/server/src/RubatoServiceRoute.ts',
  'apps/web/src/state/rubatoAuth.ts',
  'apps/web/src/rubatoAccountModelOrder.ts',
  'apps/web/src/components/settings/RubatoProvidersSettings.tsx',
  // Titles and summaries: the session-title ladder the Stats card shares.
  'apps/web/src/components/settings/RubatoTitleModels.tsx',
];

const t3Route = [
  'import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";',
  'import { useSettingsScope } from "../components/settings/SettingsScopeContext";',
  '',
  '/**',
  ' * Providers are machine state, so the page shows one environment at a time:',
  ' * the chosen one from the settings scope selector.',
  ' * A project crumb narrows candidates to where that project is registered.',
  ' */',
  'function SettingsProvidersRoute() {',
  '  const target = Route.useSearch();',
  '  const { environment, scope } = useSettingsScope();',
  '  if (!environment) {',
  '    return (',
  '      <p className="p-8 text-sm text-muted-foreground">',
  '        {scope.kind === "environment"',
  '          ? `Reconnect ${scope.label} to set up its providers.`',
  '          : "Connect an environment to set up its providers."}',
  '      </p>',
  '    );',
  '  }',
  '  return (',
  '    <ProviderSettingsPanel',
  '      environmentId={environment.environmentId}',
  '      {...(target.instanceId ? { instanceId: target.instanceId } : {})}',
  '      projectIds={',
  '        scope.kind === "project" || scope.kind === "checkout"',
  '          ? scope.members',
  '              .filter((member) => member.environmentId === environment.environmentId)',
  '              .map((member) => member.id)',
  '          : []',
  '      }',
  '      scoped',
  '    />',
  '  );',
  '}',
  '',
].join('\n');

export const providerEdits = {
  'apps/web/src/modelOrdering.ts': [
    ['import * as Arr from "effect/Array";', 'import { rubatoAccountModelRank } from "./rubatoAccountModelOrder";\n'],
    ['  return Arr.sort(models, Order.combineAll(orders));', '  return Arr.sort(models, Order.combineAll([Order.mapInput(Order.Number, (model: T) => rubatoAccountModelRank(model.slug)), ...orders]));', 'replace'],
    ['  return Arr.sort(items, Order.combineAll(orders));', '  return Arr.sort(items, Order.combineAll([Order.mapInput(Order.Number, (item: T) => rubatoAccountModelRank(item.slug)), ...orders]));', 'replace'],
  ],
  'apps/web/src/components/chat/ModelPickerContent.tsx': [
    ['import { resolveSelectableModel } from "@t3tools/shared/model";', 'import { rubatoAccountModelRank } from "../../rubatoAccountModelOrder";\n'],
    ['      return rankModelPickerSearch(candidates, searchQuery, (model) => ({', '      const ranked = rankModelPickerSearch(candidates, searchQuery, (model) => ({', 'replace'],
    ['        isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),\n      }));', '        isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),\n      }));\n      return ranked.toSorted((a, b) => rubatoAccountModelRank(a.slug) - rubatoAccountModelRank(b.slug));', 'replace'],
  ],
  'apps/server/src/server.ts': [
    ['import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";', 'import { rubatoAppRouteLayer, rubatoAuthRouteLayer, rubatoSessionStateRouteLayer } from "./RubatoServiceRoute.ts";\n'],
    ['    DeviceHubProxy.layer,\n', '    rubatoAuthRouteLayer,\n    rubatoAppRouteLayer,\n    rubatoSessionStateRouteLayer,\n'],
  ],
  'apps/web/src/routes/settings.providers.tsx': [
    [t3Route, 'import { RubatoProvidersSettingsPanel } from "../components/settings/RubatoProvidersSettings";\n', 'replace'],
    ['  component: SettingsProvidersRoute,\n', '  component: RubatoProvidersSettingsPanel,\n', 'replace'],
  ],
  // The page reads the Mac this app runs on, so the scope selects have nothing to choose.
  'apps/web/src/components/settings/SettingsScopeSentence.tsx': [
    ['  "/settings/connections",\n', '  "/settings/providers",\n'],
  ],
};
