import type { SVGProps } from "react";

/** OpenGateway mark (opengateway.ai/logo.svg). Strokes follow the surrounding text color. */
export function OpenGatewayIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 1140 650" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g stroke="currentColor" fill="currentColor">
        <rect x="36" y="36" width="420" height="578" rx="89" fill="none" strokeWidth="72" />
        <rect x="72" y="272" width="277" height="106" stroke="none" />
        <path
          d="M684 213 L684 125 A89 89 0 0 1 773 36 L1015 36 A89 89 0 0 1 1104 125 L1104 525 A89 89 0 0 1 1015 614 L773 614 A89 89 0 0 1 684 525 L684 436"
          fill="none"
          strokeWidth="72"
          strokeLinecap="butt"
        />
        <rect x="420" y="272" width="394" height="106" stroke="none" />
        <path d="M833 220 L970 325 L833 430 Z" strokeWidth="38" strokeLinejoin="round" />
      </g>
    </svg>
  );
}
