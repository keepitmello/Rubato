import { createFileRoute, redirect } from "@tanstack/react-router";

// Memory is its own page on the rail (routes/memory.tsx). The old address stays
// so settings search and older links still land there.
export const Route = createFileRoute("/_chat/settings/memory")({
  beforeLoad: () => {
    throw redirect({ to: "/memory", replace: true });
  },
});
