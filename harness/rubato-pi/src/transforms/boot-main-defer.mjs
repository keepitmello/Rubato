import { replaceOnce } from "./replace-once.mjs";

export function isBootMainUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/main.js") && !url.includes("/modes/");
}

/** TUI 부팅에 안 쓰는 CLI 모듈을 main.js 정적 그래프에서 뺀다. */
export function injectMainDeferCliModules(source) {
  let next = source;
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
    "            result = await exportFromFile(parsed.export, outputPath);\n",
    '            const { exportFromFile } = await import("./core/export-html/index.js");\n            result = await exportFromFile(parsed.export, outputPath);\n',
    "main defer export-html call",
  );
  next = replaceOnce(
    next,
    "    if (await handlePackageCommand(args, { extensionFactories })) {\n",
    '    if (await (await import("./package-manager-cli.js")).handlePackageCommand(args, { extensionFactories })) {\n',
    "main defer package command call",
  );
  next = replaceOnce(
    next,
    "    if (await handleConfigCommand(args, { extensionFactories })) {\n",
    '    if (await (await import("./package-manager-cli.js")).handleConfigCommand(args, { extensionFactories })) {\n',
    "main defer config command call",
  );
  next = replaceOnce(
    next,
    "    if (await handleAppServerCommand(args)) {\n",
    '    if (await (await import("./cli/app-server-command.js")).handleAppServerCommand(args)) {\n',
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
  return next;
}
