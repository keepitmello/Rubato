import { describe, expect, test } from "bun:test";
import { VENDOR_PATCHES } from "../postinstall.mjs";

const root = VENDOR_PATCHES[0].resolveRoot();
const { BUILTIN_SLASH_COMMANDS } = await import(`${root}/dist/core/slash-commands.js`);

const byName = new Map(BUILTIN_SLASH_COMMANDS.map((command: { name: string }) => [command.name, command]));

describe("interactive command remote metadata", () => {
  test("every built-in has an explicit capability", () => {
    expect(BUILTIN_SLASH_COMMANDS.every((command: { remoteMode?: string }) =>
      ["direct", "native-action", "terminal-only"].includes(command.remoteMode ?? ""))).toBe(true);
  });

  test("native actions and terminal-only commands match the design contract", () => {
    for (const name of ["model", "name", "new", "compact", "fork", "tree", "reload", "quit"]) {
      expect(byName.get(name)?.remoteMode).toBe("native-action");
    }
    for (const name of ["settings", "scoped-models", "export", "import", "share", "copy", "changelog", "hotkeys", "trust", "login", "logout", "resume"]) {
      expect(byName.get(name)?.remoteMode).toBe("terminal-only");
    }
  });
});
