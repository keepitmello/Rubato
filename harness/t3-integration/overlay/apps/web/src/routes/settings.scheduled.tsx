import { createFileRoute } from "@tanstack/react-router";
import { RubatoScheduleSettingsPanel } from "../components/settings/RubatoScheduleSettings";

export const Route = createFileRoute("/settings/scheduled")({ component: RubatoScheduleSettingsPanel });
