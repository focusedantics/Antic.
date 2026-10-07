import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import base from "../playwright.config";

/**
 * The trailer pipeline (not part of `npm run e2e`): `npm run trailer:capture` drives the
 * app to film its shots, `npm run trailer:render` turns them into the videos.
 */
export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: /.*\.trailer\.ts/,
  timeout: 1_800_000,
  use: { ...base.use, viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
  webServer: { ...base.webServer!, cwd: fileURLToPath(new URL("..", import.meta.url)) } as never,
});
