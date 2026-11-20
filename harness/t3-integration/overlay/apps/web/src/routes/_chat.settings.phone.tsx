import { createFileRoute } from "@tanstack/react-router";

import { RubatoPhoneSettingsPanel } from "../components/settings/RubatoPhoneSettings";

// Settings › Phone (phone-edits.mjs).
export const Route = createFileRoute("/_chat/settings/phone")({
  component: RubatoPhoneSettingsPanel,
});
