// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { manageWorkspaceEntry } from "./manageWorkspaceEntry.ts";

let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rubato-entry-")));
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "docs", "a.md"), "a");
  await fs.writeFile(path.join(root, "b.md"), "b");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const exists = (relative: string) =>
  fs.lstat(path.join(root, relative)).then(
    () => true,
    () => false,
  );

describe("manageWorkspaceEntry", () => {
  it("creates a folder, nested parents included", async () => {
    await manageWorkspaceEntry({ cwd: root, operation: "create-directory", relativePath: "x/y" });
    expect(await exists("x/y")).toBe(true);
  });

  it("refuses to create a folder that already exists", async () => {
    await expect(
      manageWorkspaceEntry({ cwd: root, operation: "create-directory", relativePath: "docs" }),
    ).rejects.toThrow(/already exists/);
  });

  it("renames a file and a folder", async () => {
    await manageWorkspaceEntry({
      cwd: root,
      operation: "rename",
      relativePath: "b.md",
      nextRelativePath: "c.md",
    });
    await manageWorkspaceEntry({
      cwd: root,
      operation: "rename",
      relativePath: "docs",
      nextRelativePath: "notes",
    });
    expect(await exists("c.md")).toBe(true);
    expect(await exists("b.md")).toBe(false);
    expect(await exists("notes/a.md")).toBe(true);
  });

  it("never overwrites on rename", async () => {
    await expect(
      manageWorkspaceEntry({
        cwd: root,
        operation: "rename",
        relativePath: "b.md",
        nextRelativePath: "docs",
      }),
    ).rejects.toThrow(/already exists/);
    expect(await fs.readFile(path.join(root, "b.md"), "utf8")).toBe("b");
  });

  it("allows a case-only rename", async () => {
    await manageWorkspaceEntry({
      cwd: root,
      operation: "rename",
      relativePath: "b.md",
      nextRelativePath: "B.md",
    });
    expect(await fs.readdir(root)).toContain("B.md");
  });

  it("refuses paths outside the workspace", async () => {
    for (const relativePath of ["../escape", "/etc", "docs/../../x", ""]) {
      await expect(
        manageWorkspaceEntry({ cwd: root, operation: "create-directory", relativePath }),
      ).rejects.toThrow(/inside this workspace/);
    }
  });

  it("refuses to act through a linked folder that leads outside", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rubato-out-")));
    try {
      await fs.writeFile(path.join(outside, "secret.md"), "s");
      await fs.symlink(outside, path.join(root, "link"));
      await expect(
        manageWorkspaceEntry({ cwd: root, operation: "trash", relativePath: "link/secret.md" }),
      ).rejects.toThrow(/inside this workspace/);
      expect(await fs.readFile(path.join(outside, "secret.md"), "utf8")).toBe("s");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("reports an entry that is already gone", async () => {
    await expect(
      manageWorkspaceEntry({ cwd: root, operation: "trash", relativePath: "missing.md" }),
    ).rejects.toThrow(/no longer exists/);
  });
});
