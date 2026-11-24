interface Summary {
  label: string;
  source?: string;
  createdAt: string;
}
export function savePrompt(state: string, instance: string, thread: string, prompt: Omit<Summary, "createdAt"> & { text: string }): Promise<Summary>;
export function readPrompt(state: string, instance: string, thread: string): Promise<(Summary & { text: string }) | null>;
export function installPromptAgent(home: string, text: string): Promise<string>;
export function verifyProfileAgent(home: string, geminiHome: string, agent: string): Promise<void>;
