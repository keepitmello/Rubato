import { createFileRoute, redirect } from "@tanstack/react-router";

// Stats lives on the rail as its own page (routes/stats.tsx). Settings lists it too,
// and this address takes the click (and settings search) there.
export const Route = createFileRoute("/settings/stats")({
  beforeLoad: () => {
    throw redirect({ to: "/stats", replace: true });
  },
});
