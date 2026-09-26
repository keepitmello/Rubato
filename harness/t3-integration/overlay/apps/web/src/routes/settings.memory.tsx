import { createFileRoute } from "@tanstack/react-router";
import { RubatoMemorySettingsPanel } from "../components/settings/RubatoMemorySettings";

export const Route = createFileRoute("/settings/memory")({ component: RubatoMemorySettingsPanel });
