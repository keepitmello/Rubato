// Runs before upstream bootstrap. Only stable Electron surfaces are wrapped;
// unfamiliar update IPC remains disabled by CODEX_SPARKLE_ENABLED=false.
const electron = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const rubatoApp = path.resolve(process.resourcesPath, '../..');
const updater = path.join(rubatoApp, 'Contents/Helpers/rubato-updater');
const icon = path.join(process.resourcesPath, 'Rubato.icns');
process.env.CODEX_SPARKLE_ENABLED = 'false';
if (!process.env.CODEX_HOME || !process.env.CODEX_ELECTRON_USER_DATA_PATH) throw new Error('Rubato must start through its isolated native launcher');
electron.app.setPath('userData', process.env.CODEX_ELECTRON_USER_DATA_PATH);
const setName = electron.app.setName.bind(electron.app);
electron.app.setName = () => setName('Rubato');
electron.app.setName('Rubato');
const setAbout = electron.app.setAboutPanelOptions.bind(electron.app);
electron.app.setAboutPanelOptions = options => setAbout({ ...options, applicationName: 'Rubato', iconPath: icon });
electron.app.setAboutPanelOptions({ applicationName: 'Rubato' });
electron.app.whenReady().then(() => {
  if (electron.app.dock) {
    const setIcon = electron.app.dock.setIcon.bind(electron.app.dock);
    electron.app.dock.setIcon = () => setIcon(icon);
    setIcon(icon);
  }
});
let checking = false;
let rubatoManager = null;
globalThis.__rubatoAttachUpdater = manager => {
  rubatoManager = manager;
  manager.options.enableUpdater = true;
  manager.inAppUpdatesLaunchPolicy = 'allowed';
  manager.inAppUpdatesLaunchPolicyResolution.resolve();
  manager.updater = { checkForUpdates: rubatoCheckUpdates, installUpdatesIfAvailable: rubatoCheckUpdates };
  manager.initialize = async () => {};
  manager.initializeMacSparkle = async () => {};
  manager.initializeUpdater = async () => {};
  manager.lastUnavailableReason = null;
};
async function rubatoCheckUpdates() {
  if (checking) return;
  checking = true;
  rubatoManager?.setUpdateLifecycleState('checking');
  try {
    const result = await new Promise((resolve, reject) => childProcess.execFile(updater, ['--check'], { timeout: 30000 }, (err, out) => {
      if (err) reject(err); else { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } }
    }));
    if (result.status !== 'available') {
      await electron.dialog.showMessageBox({ type: 'info', title: 'Rubato', message: '최신 버전입니다.', detail: `Rubato 기반 버전: ${result.current}` }); return;
    }
    const choice = await electron.dialog.showMessageBox({ type: 'info', title: 'Rubato 업데이트', message: '새 Rubato 버전을 사용할 수 있습니다.', detail: `${result.current} → ${result.latest}\n작업을 저장해 주세요. Rubato를 종료하고 업데이트 후 다시 엽니다.`, buttons: ['나중에', '설치하고 다시 열기'], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return;
    const logDir = path.join(process.env.CODEX_HOME, 'logs'); fs.mkdirSync(logDir, { recursive: true });
    const log = fs.openSync(path.join(logDir, 'rubato-update.log'), 'a', 0o600);
    const child = childProcess.spawn(updater, ['--install', '--wait-for-pid', String(process.pid), '--relaunch'], { detached: true, stdio: ['ignore', log, log] });
    child.unref(); fs.closeSync(log);
    electron.app.quit();
  } catch (error) {
    await electron.dialog.showMessageBox({ type: 'error', title: 'Rubato 업데이트', message: '업데이트를 완료하지 못했습니다.', detail: `${error.message}\n터미널에서 rubato-update --doctor로 확인할 수 있습니다.` });
  } finally { checking = false; rubatoManager?.setUpdateLifecycleState('idle'); }
}
// Preserve the existing macOS application menu and replace its update action.
// A fallback item is always inserted if the upstream menu no longer exposes it.
const buildMenu = electron.Menu.buildFromTemplate.bind(electron.Menu);
electron.Menu.buildFromTemplate = template => {
  let hooked = false;
  const visit = entries => entries.forEach(item => {
    if (item.role === 'appMenu') item.label = 'Rubato';
    if (/check.*updates|업데이트.*확인/i.test(item.label || '') || /check.*updates/i.test(item.id || '')) {
      item.label = 'Rubato 업데이트 확인…'; item.enabled = true; item.visible = true;
      item.click = rubatoCheckUpdates; delete item.role; hooked = true;
    }
    if (Array.isArray(item.submenu)) visit(item.submenu);
  });
  visit(template);
  if (!hooked && template.length) {
    const menu = template.find(item => Array.isArray(item.submenu));
    if (menu) menu.submenu.push({ label: 'Rubato 업데이트 확인…', click: rubatoCheckUpdates });
    else template.push({ label: 'Rubato 업데이트', submenu: [{ label: '업데이트 확인…', click: rubatoCheckUpdates }] });
  }
  return buildMenu(template);
};
