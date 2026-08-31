import { expect, test } from "@playwright/test"
import { createRequire } from "node:module"
import { mkdir } from "node:fs/promises"

const require = createRequire(import.meta.url)
const axePath = require.resolve("axe-core/axe.min.js")
const shots = "artifacts/screenshots"

test.beforeAll(async () => { await mkdir(shots, { recursive: true }) })

async function expectAccessible(page: import("@playwright/test").Page) {
  await page.addScriptTag({ path: axePath })
  const violations = await page.evaluate(async () => (await (window as typeof window & { axe: { run: () => Promise<{ violations: { impact: string | null; id: string }[] }> } }).axe.run()).violations.filter((item) => item.impact === "critical" || item.impact === "serious"))
  expect(violations).toEqual([])
}

test("one-time pairing URL opens a validated prefilled connection sheet", async ({ page }) => {
  const payload = Buffer.from(JSON.stringify({
    type: "rubato-host-pair",
    baseUrl: "https://hotel-tablet.example.ts.net/rubato/",
    hostId: "018f0c7b-2f3b-7c4d-9e5f-1234567890ab",
    nonce: "0123456789abcdef0123456789abcdef",
    expiresAt: "2026-08-31T01:00:00.000Z",
  })).toString("base64url")
  await page.goto(`/rubato/?fixture=1&pair=${payload}`)
  await expect(page.getByRole("dialog", { name: "Mac 연결" })).toBeVisible()
  await expect(page.getByLabel("Mac 주소")).toHaveValue("https://hotel-tablet.example.ts.net/rubato/")
  await expect(page.getByLabel("연결 코드")).toHaveValue("0123456789abcdef0123456789abcdef")
  await expect(page).not.toHaveURL(/pair=/)
  await page.getByRole("button", { name: "이 Mac 연결" }).click()
  await expect(page.getByRole("button", { name: /Hotel Tablet/ })).toBeVisible()
})

test("inventory to conversation, controls, artifacts, offline recovery", async ({ page, context }) => {
  const consoleErrors: string[] = []
  const failedRequests: string[] = []
  let terminalTickets = 0
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()) })
  page.on("requestfailed", (request) => failedRequests.push(request.url()))
  await page.route("**/api/v1/live/*/terminal/ticket", async (route) => { terminalTickets += 1; await route.fulfill({ json: { ticket: "fixture-terminal-ticket", expiresAt: "2026-08-31T01:00:00.000Z" } }) })
  await page.goto("/rubato/?fixture=1")
  await expect(page.getByRole("heading", { name: /어디서든 같은 작업/ })).toBeVisible()
  await expect(page.getByRole("button", { name: /Hotel Tablet/ })).toBeVisible()
  await expectAccessible(page)
  await page.screenshot({ path: `${shots}/inventory-iphone.png`, fullPage: true })

  await page.getByRole("button", { name: /Hotel Tablet/ }).click()
  await expect(page.getByText("접근성 테스트 4개 통과")).toBeVisible()
  const composer = page.getByRole("textbox", { name: "메시지" })
  await composer.fill("한국어 입력도 확인해 줘")
  await composer.press("Enter")
  await expect(page.getByText("한국어 입력도 확인해 줘", { exact: true })).toBeVisible()
  await expect(page.getByText("요청을 받아 작업을 시작했습니다…")).toBeVisible()

  const controlsOpener = page.getByLabel("세션 제어 열기")
  await controlsOpener.click()
  expect(await page.locator(".composer-shell").evaluate((element) => (element as HTMLElement).inert)).toBe(true)
  await page.keyboard.press("Shift+Tab")
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true)
  await page.getByRole("button", { name: "파일과 변경점" }).click()
  await expect(page.getByRole("tab", { name: "변경점" })).toBeVisible()
  await page.getByRole("tab", { name: "파일" }).click()
  await expect(page.getByText("RoomButton.tsx")).toBeVisible()
  await page.getByRole("tab", { name: "이미지" }).click()
  await expect(page.getByText("이 세션에 이미지가 없어요.")).toBeVisible()
  await page.getByRole("tab", { name: "변경점" }).click()
  await page.screenshot({ path: `${shots}/artifacts-iphone.png`, fullPage: true })
  await page.keyboard.press("Escape")
  expect(await page.locator(".composer-shell").evaluate((element) => (element as HTMLElement).inert)).toBe(false)
  await expect(controlsOpener).toBeFocused()
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false)

  await page.getByLabel("세션 제어 열기").click()
  await page.getByRole("button", { name: "모델" }).click()
  await page.getByRole("button", { name: /Claude/ }).click()
  await expect(page.getByText("Claude로 바꿨습니다.")).toBeAttached()
  await page.getByLabel("세션 제어 열기").click()
  await page.getByRole("button", { name: "대화 가지" }).click()
  await page.getByRole("button", { name: /처음 요청/ }).click()
  await page.getByLabel("세션 제어 열기").click()
  await page.getByRole("button", { name: "비상 터미널" }).click()
  await expect(page.getByRole("dialog", { name: "비상 터미널" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Esc", exact: true })).toBeVisible()
  await expect(page.getByText("현재 세션에 연결됨")).toBeVisible()
  expect(terminalTickets).toBe(1)
  await page.getByRole("button", { name: "터미널 닫기", exact: true }).click()
  await expectAccessible(page)
  expect(consoleErrors).toEqual([])
  expect(failedRequests).toEqual([])

  await context.setOffline(true)
  await page.evaluate(() => dispatchEvent(new Event("offline")))
  await expect(page.getByText(/연결이 끊겼어요/)).toBeVisible()
  await expect(composer).toBeDisabled()
  await page.screenshot({ path: `${shots}/offline-iphone.png`, fullPage: true })
  await context.setOffline(false)
  await page.evaluate(() => dispatchEvent(new Event("online")))

  await controlsOpener.click()
  await controlsOpener.evaluate((element) => element.remove())
  await page.keyboard.press("Escape")
  await expect(page.getByLabel("뒤로 가기")).toBeFocused()
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false)
})

test("structured requests, commands, images, follow-up delivery, and composer growth", async ({ page }) => {
  const sessionPath = "/rubato/session/018f0c7a-2f3b-7c4d-8e5f-1234567890ab/018f0c7b-2f3b-7c4d-9e5f-1234567890ab"
  await page.route("**/api/v1/live/*/terminal/ticket", (route) => route.fulfill({ json: { ticket: "fixture-command-terminal", expiresAt: "2026-08-31T01:00:00.000Z" } }))
  await page.goto(`${sessionPath}?fixture=1&ui=confirm&commands=skill%3Areview`)
  await expect(page.getByRole("heading", { name: "이 변경을 적용할까요?" })).toBeVisible()
  await page.getByRole("button", { name: "적용" }).click()
  await expect(page.getByRole("heading", { name: "이 변경을 적용할까요?" })).toBeHidden()

  const composerOpener = page.getByLabel("도구와 명령 열기")
  await composerOpener.click()
  await page.keyboard.press("Escape")
  await expect(composerOpener).toBeFocused()
  await composerOpener.click()
  await page.getByRole("button", { name: "스킬과 명령" }).click()
  await expect(page.getByRole("button", { name: /compact/ })).toHaveCount(0)
  await expect(page.getByRole("button", { name: /login/ })).toHaveCount(0)
  await page.getByRole("button", { name: /skill:review/ }).click()
  await expect(page.getByText("/skill:review", { exact: true })).toBeVisible()
  const composer = page.getByRole("textbox", { name: "메시지" })
  await composer.fill("첫째 줄\n둘째 줄\n셋째 줄")
  expect(await composer.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(46)

  await page.getByLabel("이미지 파일 선택").setInputFiles({ name: "room.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==", "base64") })
  await expect(page.getByText("room.png")).toBeVisible()
  await page.screenshot({ path: `${shots}/structured-input-iphone.png`, fullPage: true })
  await page.getByLabel("메시지 보내기").click()
  await expect(page.getByText("첫째 줄", { exact: false })).toBeVisible()

  await page.goto(`${sessionPath}?fixture=1&commands=compact%2Clogin`)
  await page.getByLabel("도구와 명령 열기").click()
  await page.getByRole("button", { name: "스킬과 명령" }).click()
  await expect(page.getByRole("button", { name: /skill:review/ })).toHaveCount(0)
  await page.getByRole("button", { name: /compact/ }).click()
  await expect(page.getByRole("dialog", { name: "대화 정리" })).toBeVisible()
  await page.getByLabel("대화 정리 닫기").click()
  await page.getByLabel("도구와 명령 열기").click()
  await page.getByRole("button", { name: "스킬과 명령" }).click()
  await page.getByRole("button", { name: /login/ }).click()
  await expect(page.getByRole("dialog", { name: "비상 터미널" })).toBeVisible()
  await expect(page.getByText("/login 명령은 비상 터미널에서 실행해야 합니다.")).toBeAttached()
  await page.getByRole("button", { name: "터미널 닫기", exact: true }).click()

  await page.goto(`${sessionPath}?fixture=1&state=working`)
  await page.getByRole("button", { name: "다음 차례" }).click()
  await page.getByRole("textbox", { name: "메시지" }).fill("현재 작업 뒤에 문서도 정리해 줘")
  await page.getByLabel("다음 차례에 보내기").click()
  await expect(page.getByText("다음 차례에 처리하도록 추가했습니다…")).toBeVisible()
  await expectAccessible(page)
})

test("installed shell opens when the home host is offline", async ({ page, context }) => {
  await page.goto("/rubato/")
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  await page.reload()
  await expect(page.getByRole("heading", { name: /어디서든 같은 작업/ })).toBeVisible()
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  await context.setOffline(true)
  const cachedShell = await page.evaluate(() => caches.match("/rubato/index.html").then((response) => response?.text()))
  expect(cachedShell).toContain('<div id="root"></div>')
  await context.setOffline(false)
})

test("new session path and narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto("/rubato/?fixture=1")
  await page.getByRole("button", { name: "새 세션" }).click()
  await expect(page.getByRole("heading", { name: "어느 Mac에서 시작할까요?" })).toBeVisible()
  await page.getByRole("button", { name: "계속" }).click()
  await page.getByRole("radio", { name: /Hotel Tablet/ }).click()
  await page.getByRole("button", { name: "계속" }).click()
  await expect(page.getByRole("heading", { name: "시작할 준비가 됐어요." })).toBeVisible()
  await page.screenshot({ path: `${shots}/new-session-narrow.png`, fullPage: true })
  await page.getByRole("button", { name: "세션 시작" }).click()
  await expect(page.getByRole("textbox", { name: "메시지" })).toBeVisible()
})
