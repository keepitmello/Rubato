import { createFileRoute, redirect } from "@tanstack/react-router";

// Stats is its own page on the rail (routes/stats.tsx). Settings lists it too,
// and this address takes the click (and settings search) there.
export const Route = createFileRoute("/_chat/settings/stats")({
  beforeLoad: () => {
    throw redirect({ to: "/stats", replace: true });
  },
});
