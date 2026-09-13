#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const home = process.env.RUBATO_GUI_T3_HOME;
const bridge = process.env.RUBATO_GUI_BRIDGE;
const descriptor = process.env.RUBATO_GUI_DESCRIPTOR;
const catalogue = process.env.RUBATO_GUI_CATALOGUE;
if (!home || !bridge || !descriptor || !catalogue) {
  throw new Error('RUBATO_GUI_T3_HOME, BRIDGE, DESCRIPTOR, CATALOGUE are required');
}
if (![bridge, descriptor, catalogue, home].every((value) => path.isAbsolute(value))) {
  throw new Error('GUI settings paths must be absolute');
}

const userdata = path.join(home, 'userdata');
await mkdir(userdata, { recursive: true, mode: 0o700 });

const settingsPath = path.join(userdata, 'settings.json');
let settings = {};
try { settings = JSON.parse(await readFile(settingsPath, 'utf8')); } catch { /* first install */ }
if (!settings || typeof settings !== 'object') settings = {};
const instances = settings.providerInstances && typeof settings.providerInstances === 'object'
  ? settings.providerInstances : {};
if (instances['rubato-pi'] && typeof instances['rubato-pi'] === 'object') {
  instances['rubato-pi'].enabled = false;
}
instances.rubato = {
  driver: 'rubato-pi',
  displayName: 'Rubato',
  environment: [],
  enabled: true,
  config: { bridgeModule: bridge, descriptorPath: descriptor, catalogueCwd: catalogue },
};
settings.providerInstances = instances;
settings.defaultModelSelection = { instanceId: 'rubato', model: 'xai/grok-4.6' };
await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

const clientPath = path.join(userdata, 'client-settings.json');
let client = {};
try { client = JSON.parse(await readFile(clientPath, 'utf8')); } catch { /* first install */ }
if (!client || typeof client !== 'object') client = {};
client.legacySidebarEnabled = true;
await writeFile(clientPath, `${JSON.stringify(client)}\n`);
