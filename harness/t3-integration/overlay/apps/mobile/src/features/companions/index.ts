// The companion screens the app's shell mounts (harness/t3-integration mobile/): the list is the
// first tab, the room a stack route with params { companionId, environmentId?, threadId? }, and the
// call host renders once at the app's root.
export { CompanionListScreen as CompanionListRouteScreen } from "./CompanionListScreen";
export { CompanionRoomScreen as CompanionRoomRouteScreen, type CompanionRoomParams } from "./CompanionRoomScreen";
export { RubatoCallHost } from "./RubatoCallHost";
export { useCompanions, type CompanionEntry } from "./companionsStore";
export { CallTranscriptScreen as CompanionCallRouteScreen, type CompanionCallParams } from "./CallTranscriptScreen";
export { CompanionNamesSettingsScreen as CompanionNamesSettingsRouteScreen } from "./CompanionNamesSettingsScreen";
