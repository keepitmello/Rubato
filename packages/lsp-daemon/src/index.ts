export { disposeDefaultLspManager } from "@rubato/lsp-core/lsp/manager";
export {
	type CallToolOptions,
	callDiagnosticsViaDaemon,
	callToolViaDaemon,
	currentRequestContext,
	type DaemonToolContext,
} from "./daemon-client.js";
export {
	ensureDaemonRunning,
	InvalidRuntimeOverrideError,
	RUBATO_LSP_DAEMON_CLI,
	probeDaemon,
	resolveDaemonRuntime,
} from "./ensure-daemon.js";
export {
	type DaemonPaths,
	daemonPaths,
	InvalidDaemonDirectoryError,
	InvalidDaemonVersionError,
	RUBATO_LSP_DAEMON_DIR,
	RUBATO_LSP_DAEMON_VERSION,
	validateDaemonVersion,
} from "./paths.js";
export { runMcpStdioProxy } from "./proxy.js";
