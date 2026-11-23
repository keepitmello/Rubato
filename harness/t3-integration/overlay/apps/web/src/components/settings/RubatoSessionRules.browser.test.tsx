import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import type { UserMemoryItem } from "../../state/rubatoMemory";
import { SessionRules } from "./RubatoSessionRules";

function item(label: string, state: "on" | "off" | "changed"): UserMemoryItem {
  return {
    path: `preferences/${label}.md`, text: label, summarized: true, evidence: [], updatedAt: null, conclusion: [], scope: [],
    rule: { description: `Instruction ${label}`, state, blob: "a".repeat(40) },
  };
}

it("keeps the exact wording and the user's summary together, with a separate choice per rule", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const items = [item("One", "off"), item("Two", "on"), item("Three", "changed"), item("Four", "off")];
  await using screen = await render(<SessionRules topics={[{ id: "preferences", title: "Preferences", items }]} save={save} />);
  await expect.element(screen.getByText("Instruction Three")).toBeVisible();
  await expect.element(screen.getByText("Three", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Use this version" }).click();
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ path: items[2]!.path }), true);
  await screen.getByRole("button", { name: "Leave out" }).nth(1).click();
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ path: items[1]!.path }), false);
  await screen.getByRole("button", { name: "Show all rules" }).click();
  await expect.element(screen.getByText("Instruction Four")).toBeVisible();
  save.mockRejectedValueOnce(new Error("offline"));
  await screen.getByRole("button", { name: "Leave out" }).first().click();
  await expect.element(screen.getByRole("alert")).toBeVisible();
});

it("an empty store shows where remembered rules will appear", async () => {
  await using screen = await render(<SessionRules topics={[]} save={vi.fn()} />);
  await expect.element(screen.getByText("No rules to choose yet")).toBeVisible();
});
