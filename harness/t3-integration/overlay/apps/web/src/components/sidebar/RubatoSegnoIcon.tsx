// The segno sign (𝄋), Segno's mark on the rail and in Settings: an S crossed by a slash,
// a dot on each side. Drawn on lucide's 24px grid and stroke so it sits among lucide icons.
export function RubatoSegnoIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M15.5 6.5c-.6-1.5-2-2.5-3.6-2.5-2 0-3.6 1.4-3.6 3.2 0 4.4 7.6 3.4 7.6 9.2 0 2-1.7 3.6-3.9 3.6-1.7 0-3.1-1-3.7-2.5" />
      <path d="M5.5 18.5 18.5 5.5" />
      <circle cx="6.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="17.5" cy="13.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
