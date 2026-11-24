interface Entry { id: string; label: string; source: string }
export function listSessionPrompts(): Promise<Entry[]>;
export function openSessionPromptFolder(): Promise<{folder: string}>;
export function resolveSessionPrompt(choice: unknown): Promise<{ text: string; label: string; source?: string }>;
