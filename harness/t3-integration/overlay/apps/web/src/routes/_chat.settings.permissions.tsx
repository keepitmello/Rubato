import { createFileRoute } from "@tanstack/react-router";

import { RubatoPermissionsSettings } from "../components/settings/RubatoPermissionsSettings";

// Settings › General › macOS permissions (permission-edits.mjs).
export const Route = createFileRoute("/_chat/settings/permissions")({
  component: RubatoPermissionsSettings,
});
