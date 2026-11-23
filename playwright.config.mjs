import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests-browser",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  outputDir: ".ifc-mcp/test-results",
  reporter: [["list"], ["html", { outputFolder: ".ifc-mcp/playwright-report", open: "never" }]],
  use: {
    browserName: "chromium",
    viewport: { width: 1400, height: 950 },
    launchOptions: { args: ["--enable-unsafe-swiftshader"] },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
