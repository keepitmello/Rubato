import { createFileRoute } from "@tanstack/react-router";
import { RubatoPhoneSettingsPanel } from "../components/settings/RubatoPhoneSettings";

export const Route = createFileRoute("/settings/phone")({ component: RubatoPhoneSettingsPanel });
