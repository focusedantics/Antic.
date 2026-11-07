import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import base from "../playwright.config";

/**
 * Renders the previews of templates that show effects (`npm run templates:previews`;
 * not part of `npm run e2e`): the gallery's quick sketches leave effects out.
 */
export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: /.*\.previews\.ts/,
  timeout: 1_800_000,
  webServer: { ...base.webServer!, cwd: fileURLToPath(new URL("..", import.meta.url)) } as never,
});
