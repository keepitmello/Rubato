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
  'apps/web/src/components/settings/RubatoProvidersSettings.tsx',
];

const t3Route = [
  'import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";',
  'import { useSettingsScope } from "../components/settings/SettingsScopeContext";',
  '',
  '/**',
  ' * Providers are machine state, so the page shows one environment at a time:',
  ' * the chosen one, or the representative of the selection. A project crumb',
  ' * narrows the candidates to the environments that project is registered on.',
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
  '      scoped',
  '    />',
  '  );',
  '}',
  '',
].join('\n');

export const providerEdits = {
  'apps/server/src/server.ts': [
    ['import { deviceHubProxyRouteLayer } from "./device/DeviceHubProxy.ts";', 'import { rubatoAppRouteLayer, rubatoAuthRouteLayer } from "./RubatoServiceRoute.ts";\n'],
    ['    deviceHubProxyRouteLayer,\n', '    rubatoAuthRouteLayer,\n    rubatoAppRouteLayer,\n'],
  ],
  'apps/web/src/routes/settings.providers.tsx': [
    [t3Route, 'import { RubatoProvidersSettingsPanel } from "../components/settings/RubatoProvidersSettings";\n', 'replace'],
    ['  component: SettingsProvidersRoute,\n', '  component: RubatoProvidersSettingsPanel,\n', 'replace'],
  ],
  // The page reads the Mac this app runs on, so the scope selects have nothing to choose.
  'apps/web/src/routes/settings.tsx': [
    ['  "/settings/connections",\n', '  "/settings/providers",\n'],
  ],
};
