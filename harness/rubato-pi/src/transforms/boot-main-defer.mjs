import { replaceOnce } from "./replace-once.mjs";

export function isBootMainUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/main.js") && !url.includes("/modes/");
}

/** TUI 부팅에 안 쓰는 CLI 모듈을 main.js 정적 그래프에서 뺀다. */
export function injectMainDeferCliModules(source) {
  let next = source;
  next = replaceOnce(
    next,
    'import { checkProviderAuth, createAuthCheckModelRuntime, getProviderCredential, } from "./cli/auth-check.js";\n',
    "",
    "main defer auth-check import",
  );
  next = replaceOnce(
    next,
    'import { AuthCommandError, getAuthCommandName, getAuthCommandUsage, isAuthCommandHelp, parseAuthCommand, printAuthCommandHelp, validateAuthCommandArgs, } from "./cli/auth-command.js";\n',
    "",
    "main defer auth-command import",
  );
  next = replaceOnce(
    next,
    'import { resolveCredentialForPrint } from "./cli/credential-print.js";\n',
    "",
    "main defer credential-print import",
  );
  next = replaceOnce(
    next,
    'import { processFileArguments } from "./cli/file-processor.js";\n',
    "",
    "main defer file-processor import",
  );
  next = replaceOnce(
    next,
    'import { shouldRunFirstTimeSetup, showFirstTimeSetup, showStartupSelector } from "./cli/startup-ui.js";\n',
    "",
    "main defer startup-ui import",
  );
  next = replaceOnce(
    next,
    'import { APP_NAME, DISPLAY_VERSION, ENV_SESSION_DIR, expandTildePath, getAgentDir, getPackageDir } from "./config.js";\n',
    'import { APP_NAME, DISPLAY_VERSION, ENV_AGENT_DIR, ENV_SESSION_DIR, expandTildePath, getAgentDir, getPackageDir } from "./config.js";\n',
    "main defer ENV_AGENT_DIR",
  );
  next = replaceOnce(
    next,
    'import { handleAppServerCommand } from "./cli/app-server-command.js";\n',
    "",
    "main defer app-server import",
  );
  next = replaceOnce(
    next,
    'import { listModels } from "./cli/list-models.js";\n',
    "",
    "main defer list-models import",
  );
  next = replaceOnce(
    next,
    'import { listTips } from "./cli/list-tips.js";\n',
    "",
    "main defer list-tips import",
  );
  next = replaceOnce(
    next,
    'import { selectSession } from "./cli/session-picker.js";\n',
    "",
    "main defer session-picker import",
  );
  next = replaceOnce(
    next,
    'import { exportFromFile } from "./core/export-html/index.js";\n',
    "",
    "main defer export-html import",
  );
  next = replaceOnce(
    next,
    'import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.js";\n',
    'import { InteractiveMode } from "./modes/interactive/interactive-mode.js";\n',
    "main defer modes barrel",
  );
  next = replaceOnce(
    next,
    'import { runMultiSessionHost } from "./modes/rpc/multi-session-host.js";\n',
    "",
    "main defer multi-session-host import",
  );
  next = replaceOnce(
    next,
    'import { handleConfigCommand, handlePackageCommand } from "./package-manager-cli.js";\n',
    "",
    "main defer package-manager-cli import",
  );
  next = replaceOnce(
    next,
    'import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.js";\n',
    "",
    "main defer windows-self-update import",
  );
  next = replaceOnce(
    next,
    "            result = await exportFromFile(parsed.export, outputPath);\n",
    '            const { exportFromFile } = await import("./core/export-html/index.js");\n            result = await exportFromFile(parsed.export, outputPath);\n',
    "main defer export-html call",
  );
  next = replaceOnce(
    next,
    "    if (await handlePackageCommand(args, { extensionFactories })) {\n",
    '    if ((args[0] === "install" || args[0] === "uninstall" || args[0] === "remove" || args[0] === "update" || args[0] === "list") && await (await import("./package-manager-cli.js")).handlePackageCommand(args, { extensionFactories })) {\n',
    "main defer package command call",
  );
  next = replaceOnce(
    next,
    "    if (await handleConfigCommand(args, { extensionFactories })) {\n",
    '    if (args[0] === "config" && await (await import("./package-manager-cli.js")).handleConfigCommand(args, { extensionFactories })) {\n',
    "main defer config command call",
  );
  next = replaceOnce(
    next,
    "    if (await handleAppServerCommand(args)) {\n",
    '    if (args[0] === "app-server" && await (await import("./cli/app-server-command.js")).handleAppServerCommand(args)) {\n',
    "main defer app-server call",
  );
  next = replaceOnce(
    next,
    "            const selectedPath = await selectSession(",
    '            const { selectSession } = await import("./cli/session-picker.js");\n            const selectedPath = await selectSession(',
    "main defer session-picker call",
  );
  next = replaceOnce(
    next,
    "        listTips();\n",
    '        const { listTips } = await import("./cli/list-tips.js");\n        listTips();\n',
    "main defer list-tips call",
  );
  next = replaceOnce(
    next,
    "        await listModels(services.modelRuntime, searchPattern);\n",
    '        const { listModels } = await import("./cli/list-models.js");\n        await listModels(services.modelRuntime, searchPattern);\n',
    "main defer list-models call",
  );
  next = replaceOnce(
    next,
    "        await runMultiSessionHost({",
    '        const { runMultiSessionHost } = await import("./modes/rpc/multi-session-host.js");\n        await runMultiSessionHost({',
    "main defer multi-session-host call",
  );
  next = replaceOnce(
    next,
    "        await runRpcMode(runtime);\n",
    '        const { runRpcMode } = await import("./modes/rpc/rpc-mode.js");\n        await runRpcMode(runtime);\n',
    "main defer rpc-mode call",
  );
  next = replaceOnce(
    next,
    "        const exitCode = await runPrintMode(runtime, {",
    '        const { runPrintMode } = await import("./modes/print-mode.js");\n        const exitCode = await runPrintMode(runtime, {',
    "main defer print-mode call",
  );
  next = replaceOnce(
    next,
    "async function runAuthCommand(args) {\n    if (isAuthCommandHelp(args)) {\n",
    `async function runAuthCommand(args) {
    if (args[0] !== "auth")
        return false;
    const { AuthCommandError, getAuthCommandName, getAuthCommandUsage, isAuthCommandHelp, parseAuthCommand, printAuthCommandHelp, validateAuthCommandArgs } = await import("./cli/auth-command.js");
    const { checkProviderAuth, createAuthCheckModelRuntime, getProviderCredential } = await import("./cli/auth-check.js");
    const { resolveCredentialForPrint } = await import("./cli/credential-print.js");
    if (isAuthCommandHelp(args)) {
`,
    "main defer auth command body",
  );
  next = replaceOnce(
    next,
    "    const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });\n",
    '    const { processFileArguments } = await import("./cli/file-processor.js");\n    const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });\n',
    "main defer file-processor call",
  );
  next = replaceOnce(
    next,
    "    return showStartupSelector(settingsManager, formatMissingSessionCwdPrompt(issue), [\n",
    '    const { showStartupSelector } = await import("./cli/startup-ui.js");\n    return showStartupSelector(settingsManager, formatMissingSessionCwdPrompt(issue), [\n',
    "main defer startup-ui missing-cwd",
  );
  next = replaceOnce(
    next,
    '    if (process.platform === "win32") {\n        cleanupWindowsSelfUpdateQuarantine(getPackageDir());\n    }\n',
    '    if (process.platform === "win32") {\n        const { cleanupWindowsSelfUpdateQuarantine } = await import("./utils/windows-self-update.js");\n        cleanupWindowsSelfUpdateQuarantine(getPackageDir());\n    }\n',
    "main defer windows-self-update call",
  );
  next = replaceOnce(
    next,
    `    if (appMode === "interactive" &&
        !parsed.help &&
        parsed.listModels === undefined &&
        !parsed.listTips &&
        shouldRunFirstTimeSetup()) {
        await showFirstTimeSetup(startupSettingsManager);
        time("firstTimeSetup");
    }
`,
    `    if (appMode === "interactive" &&
        !parsed.help &&
        parsed.listModels === undefined &&
        !parsed.listTips &&
        !process.env[ENV_AGENT_DIR]) {
        const { shouldRunFirstTimeSetup, showFirstTimeSetup } = await import("./cli/startup-ui.js");
        if (shouldRunFirstTimeSetup()) {
            await showFirstTimeSetup(startupSettingsManager);
            time("firstTimeSetup");
        }
    }
`,
    "main defer first-time setup",
  );
  return next;
}
