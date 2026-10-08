import { defineConfig, devices } from "@playwright/test";
import { E2E_ENV, E2E_PORT } from "./tests/fixture";

// Starts its own dev server on E2E_PORT with its own settings file and backup folder
// (tests/fixture.ts), so it never touches a dev server you have running on 5190, your
// remembered collection, or your kept originals. Needs Bloom installed, for its ffmpeg.
export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  // One server holds one collection and one job at a time, so tests run one after another.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    headless: true,
    trace: "retain-on-failure",
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
  webServer: {
    command: "vp dev",
    url: `http://localhost:${E2E_PORT}/api/health`,
    env: E2E_ENV,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
});
