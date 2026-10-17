import { createFileRoute, redirect } from "@tanstack/react-router";

// Memory moved out of Settings to its own page on the rail (routes/memory.tsx).
// The old address stays so settings search and older links still land there.
export const Route = createFileRoute("/settings/memory")({
  beforeLoad: () => {
    throw redirect({ to: "/memory", replace: true });
  },
});
