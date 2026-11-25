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
  'packages/shared/src/rubatoAgyAccounts.ts',
  'packages/shared/src/rubatoAgyAccounts.test.ts',
  'packages/shared/src/rubatoAgyPickerAccounts.test.ts',
  'apps/web/src/components/chat/rubatoAgyPicker.ts',
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
    // Rubato: one rail icon per Antigravity login, its agy agents a choice above the models (rubatoAgyPicker.ts).
    [
      "import { ModelListRow } from \"./ModelListRow\";\n",
      "import { useAgyPickerAccounts } from \"./rubatoAgyPicker\";\n",
    ],
    [
      "  const instanceOrder = instanceEntries.map((entry) => entry.instanceId);\n",
      "  // Rubato: one rail icon per Antigravity login; the agy agents on it are a choice above its\n  // models (rubatoAgyPicker.ts).\n  const agyPickerAccounts = useAgyPickerAccounts(\n    props.environmentId,\n    sidebarInstanceEntries.map((entry) => entry.instanceId),\n  );\n  const agyAccountOf = (instanceId: ProviderInstanceId | \"favorites\") =>\n    instanceId === \"favorites\"\n      ? undefined\n      : agyPickerAccounts.find((account) =>\n          account.agents.some((agent) => agent.instanceId === instanceId),\n        );\n  const railIdOf = (instanceId: ProviderInstanceId | \"favorites\"): ProviderInstanceId | \"favorites\" => {\n    const account = agyAccountOf(instanceId);\n    return account ? (account.railId as ProviderInstanceId) : instanceId;\n  };\n  const railEntries = sidebarInstanceEntries.flatMap((entry) => {\n    const account = agyAccountOf(entry.instanceId);\n    if (!account) return [entry];\n    return entry.instanceId === account.railId ? [{ ...entry, displayName: account.label }] : [];\n  });\n  // A login's icon stays usable while the thread can still continue on one of its agents.\n  const railDisabledInstanceIds = (() => {\n    if (!lockedDisabledInstanceIds) return undefined;\n    const disabled = new Set(lockedDisabledInstanceIds);\n    for (const account of agyPickerAccounts) {\n      if (account.agents.some((agent) => !lockedDisabledInstanceIds.has(agent.instanceId as ProviderInstanceId))) {\n        disabled.delete(account.railId as ProviderInstanceId);\n      }\n    }\n    return disabled;\n  })();\n  const agyAgentChoices =\n    isSearching || selectedInstanceId === \"favorites\"\n      ? undefined\n      : agyAccountOf(selectedInstanceId)?.agents;\n",
    ],
    [
      "        entries: sidebarInstanceEntries,\n        selectedInstanceId,\n        direction: command === \"modelPicker.nextProvider\" ? 1 : -1,\n        disabledInstanceIds: lockedDisabledInstanceIds,",
      "        entries: railEntries,\n        selectedInstanceId: railIdOf(selectedInstanceId),\n        direction: command === \"modelPicker.nextProvider\" ? 1 : -1,\n        disabledInstanceIds: railDisabledInstanceIds,",
      'replace',
    ],
    [
      "        next === \"favorites\" ? gt(\"Favorites\") : (entryByInstanceId.get(next)?.displayName ?? next),",
      "        next === \"favorites\"\n          ? gt(\"Favorites\")\n          : (railEntries.find((entry) => entry.instanceId === next)?.displayName ?? next),",
      'replace',
    ],
    [
      "          <ModelPickerSidebar\n            selectedInstanceId={selectedInstanceId}\n            onSelectInstance={handleSelectInstance}\n            onFocusSearch={focusSearchInput}\n            instanceEntries={sidebarInstanceEntries}\n            showFavorites\n            {...(selectableUnavailableInstanceIds ? { selectableUnavailableInstanceIds } : {})}\n            {...(lockedDisabledInstanceIds\n              ? {\n                  disabledInstanceIds: lockedDisabledInstanceIds,",
      "          <ModelPickerSidebar\n            selectedInstanceId={railIdOf(selectedInstanceId)}\n            onSelectInstance={handleSelectInstance}\n            onFocusSearch={focusSearchInput}\n            instanceEntries={railEntries}\n            showFavorites\n            {...(selectableUnavailableInstanceIds ? { selectableUnavailableInstanceIds } : {})}\n            {...(railDisabledInstanceIds\n              ? {\n                  disabledInstanceIds: railDisabledInstanceIds,",
      'replace',
    ],
    [
      "            <ModelPickerList\n",
      "            {agyAgentChoices && agyAgentChoices.length > 1 ? (\n              <div\n                role=\"radiogroup\"\n                aria-label=\"Agent\"\n                className=\"flex flex-wrap gap-1 border-b border-border/60 px-2 py-1.5\"\n              >\n                {agyAgentChoices.map((agent) => {\n                  const instanceId = agent.instanceId as ProviderInstanceId;\n                  const checked = instanceId === selectedInstanceId;\n                  return (\n                    <button\n                      key={instanceId}\n                      type=\"button\"\n                      role=\"radio\"\n                      aria-checked={checked}\n                      disabled={lockedDisabledInstanceIds?.has(instanceId) ?? false}\n                      onClick={() => handleSelectInstance(instanceId)}\n                      onMouseDown={(event) => event.preventDefault()}\n                      className={cn(\n                        \"rounded-md px-2 py-0.5 text-xs transition-colors disabled:pointer-events-none disabled:opacity-50\",\n                        checked\n                          ? \"bg-accent font-medium text-foreground\"\n                          : \"text-muted-foreground hover:bg-accent/60 hover:text-foreground\",\n                      )}\n                    >\n                      {agent.label}\n                    </button>\n                  );\n                })}\n              </div>\n            ) : null}\n",
    ],
    [
      "                    showInstanceBadge={badgedInstanceIds.has(model.instanceId)}",
      "                    showInstanceBadge={\n                      badgedInstanceIds.has(model.instanceId) && agyAgentChoices === undefined\n                    }",
      'replace',
    ],
  ],
  'apps/server/src/server.ts': [
    ['import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";', 'import { rubatoAppRouteLayer, rubatoAuthRouteLayer, rubatoSessionStateRouteLayer } from "./RubatoServiceRoute.ts";\n'],
    ['    DeviceHubProxy.layer,\n', '    rubatoAuthRouteLayer,\n    rubatoAppRouteLayer,\n    rubatoSessionStateRouteLayer,\n'],
  ],
  // The desktop's settings and picker and the phone's thread settings group Antigravity logins alike.
  'packages/shared/package.json': [
    ['    "./pullRequestAnchor": {\n',
      '    "./rubatoAgyAccounts": {\n      "types": "./src/rubatoAgyAccounts.ts",\n      "import": "./src/rubatoAgyAccounts.ts"\n    },\n'],
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
