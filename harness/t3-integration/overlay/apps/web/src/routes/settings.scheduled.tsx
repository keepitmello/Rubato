import { createFileRoute, redirect } from "@tanstack/react-router";

// Scheduled tasks moved out of Settings to their own page on the rail
// (routes/scheduled.tsx). The old address stays so settings search and older
// links still land there.
export const Route = createFileRoute("/settings/scheduled")({
  beforeLoad: () => {
    throw redirect({ to: "/scheduled", replace: true });
  },
});
