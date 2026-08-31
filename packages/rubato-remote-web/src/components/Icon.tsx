import type { SVGProps } from "react"

export type AppIconName =
  | "settings"
  | "plus"
  | "chevron-right"
  | "back"
  | "close"
  | "mac"
  | "folder"
  | "spark"
  | "clock"
  | "check"
  | "warning"
  | "offline"
  | "more"
  | "paperclip"
  | "send"
  | "stop"
  | "command"
  | "model"
  | "brain"
  | "compress"
  | "branch"
  | "people"
  | "file"
  | "terminal"
  | "refresh"
  | "edit"
  | "bell"
  | "appearance"
  | "star"
  | "diagnostics"
  | "link"
  | "download"
  | "upload"
  | "trash"
  | "network"
  | "image"
  | "queue"

const paths: Record<AppIconName, readonly string[]> = {
  settings: ["M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z", "M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2 3.46-.09-.03a1.7 1.7 0 0 0-1.8.28l-.63.37a1.7 1.7 0 0 0-.82 1.64V23h-4v-.34A1.7 1.7 0 0 0 9.64 21l-.63-.36a1.7 1.7 0 0 0-1.8-.28l-.09.03-2-3.46.06-.06A1.7 1.7 0 0 0 5.52 15l-.01-.72a1.7 1.7 0 0 0-1-1.54l-.09-.04 2-3.46.1.02a1.7 1.7 0 0 0 1.78-.32l.62-.37A1.7 1.7 0 0 0 9.74 7V6.9h4.52V7a1.7 1.7 0 0 0 .82 1.56l.63.37a1.7 1.7 0 0 0 1.78.32l.1-.02 2 3.46-.09.04a1.7 1.7 0 0 0-1 1.54l-.01.72Z"],
  plus: ["M12 5v14", "M5 12h14"],
  "chevron-right": ["m9 6 6 6-6 6"],
  back: ["m15 18-6-6 6-6"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  mac: ["M5 5.5h14a1 1 0 0 1 1 1v9H4v-9a1 1 0 0 1 1-1Z", "M3 18.5h18", "M9 18.5h6"],
  folder: ["M3.5 7.5h6l1.7 2H20a1 1 0 0 1 1 1v7.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V9a1.5 1.5 0 0 1 .5-1.5Z"],
  spark: ["M12 3.5 13.4 8l4.6 1.4-4.6 1.5L12 15.5l-1.4-4.6L6 9.4 10.6 8 12 3.5Z", "m18.5 15 .7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1Z"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 7v5l3 2"],
  check: ["m5 12 4 4L19 6"],
  warning: ["M12 3 2.8 20h18.4L12 3Z", "M12 9v4", "M12 17h.01"],
  offline: ["M5 5a14.5 14.5 0 0 1 14 0", "M7.8 8.2a10.3 10.3 0 0 1 8.4 0", "M10.6 11.4a5.7 5.7 0 0 1 2.8 0", "M4 4l16 16"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  paperclip: ["m9.5 12.5 5.7-5.7a3 3 0 1 1 4.2 4.2l-7.8 7.8a5 5 0 0 1-7.1-7.1l7.4-7.4"],
  send: ["M4 4.5 20 12 4 19.5l2-6 8-1.5-8-1.5-2-6Z"],
  stop: ["M7 7h10v10H7z"],
  command: ["M9 8H6a3 3 0 1 1 3-3v14a3 3 0 1 1-3-3h12a3 3 0 1 1-3 3V5a3 3 0 1 1 3 3H9Z"],
  model: ["M12 3 20 7.5 12 12 4 7.5 12 3Z", "m4 12 8 4.5 8-4.5", "m4 16.5 8 4.5 8-4.5"],
  brain: ["M9 5.5A3 3 0 0 0 4.5 8a3.5 3.5 0 0 0 .5 6.9A3 3 0 0 0 9 18.5V5.5Z", "M15 5.5A3 3 0 0 1 19.5 8a3.5 3.5 0 0 1-.5 6.9 3 3 0 0 1-4 3.6V5.5Z", "M9 9h2", "M13 12h2", "M9 15h2"],
  compress: ["M8 3v5H3", "m3 8 5-5", "M16 3v5h5", "m21 8-5-5", "M8 21v-5H3", "m3 16 5 5", "M16 21v-5h5", "m21 16-5 5"],
  branch: ["M7 4v9a4 4 0 0 0 4 4h6", "m13 13 4 4-4 4", "M17 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z", "M7 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"],
  people: ["M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M3 21v-2a6 6 0 0 1 12 0v2", "M17 5.2a3.4 3.4 0 0 1 0 6.6", "M18 15a5 5 0 0 1 3 4.6V21"],
  file: ["M6 3h8l4 4v14H6V3Z", "M14 3v5h5", "M9 13h6", "M9 17h4"],
  terminal: ["M4 5h16v14H4V5Z", "m7 9 3 3-3 3", "M12.5 15H16"],
  refresh: ["M20 6v5h-5", "M4 18v-5h5", "M18.5 10A7 7 0 0 0 6.4 6.5L4 11", "M5.5 14A7 7 0 0 0 17.6 17.5L20 13"],
  edit: ["M4 20h4l11-11-4-4L4 16v4Z", "m13.5 2.5 4 4"],
  bell: ["M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8Z", "M10 21h4"],
  appearance: ["M12 21a9 9 0 1 0 0-18v18Z", "M12 3v18"],
  star: ["m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"],
  diagnostics: ["M4 19h16", "M6 16v-5", "M10 16V7", "M14 16v-3", "M18 16V4"],
  link: ["M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1", "M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"],
  download: ["M12 3v12", "m7 10 5 5 5-5", "M5 21h14"],
  upload: ["M12 21V9", "m7 14 5-5 5 5", "M5 3h14"],
  trash: ["M4 7h16", "M9 7V4h6v3", "m6 7 1 14h10l1-14", "M10 11v6", "M14 11v6"],
  network: ["M4 8h16", "M4 16h16", "M8 4v16", "M16 4v16", "M4 4h16v16H4z"],
  image: ["M4 5h16v14H4V5Z", "M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z", "m5 17 4-4 3 3 2-2 5 3"],
  queue: ["M5 7h14", "M5 12h14", "M5 17h9", "m17 15 2 2-2 2"],
}

export function AppIcon({ name, size = 20, strokeWidth = 1.8, ...props }: SVGProps<SVGSVGElement> & { name: AppIconName; size?: number; strokeWidth?: number }) {
  return <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    focusable="false"
    {...props}
  >
    {paths[name].map((path, index) => <path key={`${name}-${index}`} d={path} />)}
  </svg>
}
