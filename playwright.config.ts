import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:4100",
    actionTimeout: 8000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "node server/index.js",
    url: "http://localhost:4100/api/config",
    reuseExistingServer: true,
    timeout: 30000,
    env: {
      PORT: "4100",
      RETURNS_DB: "./server/e2e.db",
    },
  },
});
