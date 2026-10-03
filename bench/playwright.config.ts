import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import base from "../playwright.config";

/**
 * Memory benchmark (not part of `npm run e2e`): `npm run bench`. Drives a phone-sized
 * session with large photos and reports the browser's peak memory per phase.
 */
export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: /.*\.bench\.ts/,
  timeout: 600_000,
  webServer: { ...base.webServer!, cwd: fileURLToPath(new URL("..", import.meta.url)) } as never,
});
