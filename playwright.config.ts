import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests drive the real app in Chromium with WebGL (SwiftShader when
 * no GPU is present). Set CHROMIUM_PATH to use a preinstalled browser.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://localhost:5174",
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
    },
  },
  webServer: {
    command: "npx vite --port 5174 --strictPort",
    url: "http://localhost:5174",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
