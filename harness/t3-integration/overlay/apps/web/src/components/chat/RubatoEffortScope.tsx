// Under the effort levels in the model picker: a level picked there is this conversation's only;
// the level new conversations start at is set in Settings > Providers (RubatoEffortSettings.tsx).
import { Link } from "@tanstack/react-router";

// The levels column is about 200px wide, so the note and its link take a line each.
export function RubatoEffortScope() {
  return (
    <div className="mt-1 flex flex-col items-start gap-0.5 border-t border-border/70 px-2 pt-1.5 text-muted-foreground text-xs">
      <span>This conversation only</span>
      <Link
        to="/settings/providers"
        hash="rubato-thinking-effort"
        className="text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
      >
        Change default
      </Link>
    </div>
  );
}
