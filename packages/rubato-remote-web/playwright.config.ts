import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["list"], ["html", { outputFolder: "artifacts/playwright-report", open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    ...devices["iPhone 15"],
    browserName: "webkit",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "env -u NODE_OPTIONS npm run preview -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173/rubato/?fixture=1",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
