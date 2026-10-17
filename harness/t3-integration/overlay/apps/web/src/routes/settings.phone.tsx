import { createFileRoute, redirect } from "@tanstack/react-router";

// Phone is part of Connections in Rubato's Settings layout (settings-layout-edits.mjs).
export const Route = createFileRoute("/settings/phone")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/connections", hash: "rubato-phone", replace: true });
  },
});
