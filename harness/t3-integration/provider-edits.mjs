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
  'apps/web/src/rubatoAccountLabel.ts',
  'apps/web/src/components/settings/RubatoProvidersSettings.tsx',
  // Antigravity: Google logins as accounts, agy agents on them as system prompts.
  'apps/web/src/components/settings/RubatoAgyAccounts.logic.ts',
  'apps/web/src/components/settings/RubatoAgyAccounts.logic.test.ts',
  // Titles and summaries: the session-title ladder the Stats card shares.
  'apps/web/src/components/settings/RubatoTitleModels.tsx',
  // Thinking effort: the level new conversations start at (src/auth/effort.mjs), and the line under
  // the picker's levels that says a level picked there stays in the conversation.
  'apps/web/src/components/settings/RubatoEffortSettings.tsx',
  'apps/web/src/components/settings/RubatoEffortSettings.logic.ts',
  'apps/web/src/components/settings/RubatoEffortSettings.logic.test.ts',
  'apps/web/src/components/chat/RubatoEffortScope.tsx',
];

const t3Route = [
  'import { useGT } from "gt-react";',
  '',
  'import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";',
  'import { useSettingsScope } from "../components/settings/SettingsScopeContext";',
  '',
  'function SettingsProvidersRoute() {',
  '  const target = Route.useSearch();',
  '  const { environment, scope } = useSettingsScope();',
  '  const gt = useGT();',
  '  if (!environment) {',
  '    return (',
  '      <p className="p-8 text-sm text-muted-foreground">',
  '        {scope.kind === "environment"',
  '          ? gt("Reconnect {label} to set up its providers.", { label: scope.label })',
  '          : gt("Connect an environment to set up its providers.")}',
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
  'apps/web/src/routes/_chat.settings.providers.tsx': [
    [t3Route, 'import { RubatoProvidersSettingsPanel } from "../components/settings/RubatoProvidersSettings";\n', 'replace'],
    ['  component: SettingsProvidersRoute,\n', '  component: RubatoProvidersSettingsPanel,\n', 'replace'],
  ],
  // Under the picker's levels: a level picked here stays in this conversation; the default is on this page.
  'apps/web/src/components/chat/ComposerModelEffort.tsx': [
    ['import { ComposerPermissionsSection, type RuntimeModeOption } from "./ComposerFooterControls";\n',
      'import { RubatoEffortScope } from "./RubatoEffortScope";\n'],
    [[
      '  return (',
      '    <div role="radiogroup" aria-label={descriptor.label} className="flex flex-col gap-0.5">',
      '      {locked ? (',
    ].join('\n'), [
      '  return (',
      '    <>',
      '    <div role="radiogroup" aria-label={descriptor.label} className="flex flex-col gap-0.5">',
      '      {locked ? (',
    ].join('\n'), 'replace'],
    [[
      '          onPick={() => traits.changeSelect(control.descriptor, option.id)}',
      '        />',
      '      ))}',
      '    </div>',
      '  );',
      '}',
      '',
    ].join('\n'), [
      '          onPick={() => traits.changeSelect(control.descriptor, option.id)}',
      '        />',
      '      ))}',
      '    </div>',
      '    {/* Rubato: where the default lives (provider-edits.mjs). */}',
      '    <RubatoEffortScope />',
      '    </>',
      '  );',
      '}',
      '',
    ].join('\n'), 'replace'],
  ],
  // The page reads the Mac this app runs on, so the scope selects have nothing to choose.
  'apps/web/src/components/settings/SettingsScopeSentence.tsx': [
    ['  "/settings/connections",\n', '  "/settings/providers",\n'],
  ],
};
