import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";

function parseArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const pair = process.argv.find((entry) => entry.startsWith(prefix));
  if (pair) return pair.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const outPath = parseArg("out", "tests/.auth/default.json");
const label = parseArg("label", "user");
const baseURL = parseArg("base-url", process.env.E2E_BASE_URL || "http://127.0.0.1:3000");

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

console.log(`[auth:${label}] Opening ${baseURL}`);
await page.goto(baseURL, { waitUntil: "domcontentloaded" });

if (await page.locator("#start-game-btn").count()) {
  await page.locator("#start-game-btn").click();
}
await page.locator("#mode-online").click();

console.log(`[auth:${label}] Sign in on this browser. Waiting for Sign Out button...`);
await page.locator('[data-online-action="auth-logout"]').first().waitFor({ timeout: 240000 });

const absOut = path.resolve(outPath);
await fs.mkdir(path.dirname(absOut), { recursive: true });
await context.storageState({ path: absOut });

console.log(`[auth:${label}] Saved state -> ${absOut}`);
await browser.close();
