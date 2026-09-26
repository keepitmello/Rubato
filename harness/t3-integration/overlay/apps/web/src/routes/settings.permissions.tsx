import { createFileRoute } from "@tanstack/react-router";

import { RubatoPermissionsSettings } from "../components/settings/RubatoPermissionsSettings";

export const Route = createFileRoute("/settings/permissions")({
  component: RubatoPermissionsSettings,
});
