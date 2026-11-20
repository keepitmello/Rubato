import { msg, T, useMessages } from "gt-react";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../test/render";
import { RubatoCallCard } from "./components/chat/RubatoCallCard";
import { updateClientSettings } from "./hooks/useSettings";
import { I18nProvider } from "./i18n/I18nProvider";
import { startI18n, whenLocaleReady } from "./i18n/runtime";
import type { CallRecord } from "./state/rubatoCall";

const call: CallRecord = {
  id: "call-1",
  companion: "segno",
  direction: "outgoing",
  status: "ended",
  reason: null,
  createdAt: Date.UTC(2026, 10, 21, 1, 0),
  answeredAt: Date.UTC(2026, 10, 21, 1, 0),
  endedAt: Date.UTC(2026, 10, 21, 1, 3),
  transcript: [],
};

function T3Text() {
  const m = useMessages();
  return (
    <>
      <p data-testid="message">{m(msg("Add a project"))}</p>
      <p data-testid="jsx">
        <T>Add a project</T>
      </p>
    </>
  );
}

async function switchTo(language: string) {
  await updateClientSettings({ language });
  await whenLocaleReady();
}

it("shows T3's text in Rubato's wording and Rubato's own text in Korean, and back", async () => {
  startI18n();
  await switchTo("ko");
  await using screen = await render(
    <I18nProvider>
      <T3Text />
      <RubatoCallCard call={call} title="Segno" locale="ko" />
    </I18nProvider>,
  );

  // T3's own Korean would be "프로젝트 추가"; Rubato's dictionary says "프로젝트 추가하기".
  await expect.element(screen.getByTestId("message")).toHaveTextContent("프로젝트 추가하기");
  await expect.element(screen.getByTestId("jsx")).toHaveTextContent("프로젝트 추가하기");
  // RubatoCallCard writes "You called" and "Voice call" as English literals.
  await expect.element(page.getByText("내가 건 통화", { exact: true })).toBeVisible();
  await expect.element(page.getByText("통화", { exact: true })).toBeVisible();

  await switchTo("en");
  await expect.element(screen.getByTestId("message")).toHaveTextContent("Add a project");
  await expect.element(page.getByText("You called", { exact: true })).toBeVisible();
});
