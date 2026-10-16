// `/rubato/session-state` on the T3 server lands here (RubatoServiceRoute.ts loads this module
// next to the bridge module the Rubato provider runs, so it sees the live bridge).
import { liveBridge } from './bridge.mjs';
import { createSessionStateService, handleSessionStateRequest } from './session-state.mjs';

let service;
export const sessionStateService = () => (service ??= createSessionStateService({ bridge: liveBridge }));
export { handleSessionStateRequest };
