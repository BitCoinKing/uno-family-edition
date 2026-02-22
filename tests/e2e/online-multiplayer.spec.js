import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const HOST_STATE = process.env.PW_HOST_STATE || "tests/.auth/host.json";
const JOINER_STATE = process.env.PW_JOINER_STATE || "tests/.auth/joiner.json";

function hasAuthStates() {
  return fs.existsSync(path.resolve(HOST_STATE)) && fs.existsSync(path.resolve(JOINER_STATE));
}

async function openSetupOnline(page, appUrl) {
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });

  if (await page.locator("#start-game-btn").count()) {
    await page.locator("#start-game-btn").click();
  }

  await expect(page.locator("#mode-online")).toBeVisible();
  await page.locator("#mode-online").click();
  await expect(page.locator("#online-panel")).toBeVisible();
  await expect(page.locator('[data-online-action="auth-logout"]').first()).toBeVisible();
}

async function waitForRoomCode(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await page.locator(".online-room-meta p").first().textContent().catch(() => "");
    const match = (text || "").match(/Room:\s*([A-Z0-9]+)/i);
    const code = (match?.[1] || "").trim();
    if (code && code !== "-") return code;
    await page.waitForTimeout(250);
  }
  throw new Error("Room code did not appear in time.");
}

async function canAct(page) {
  const draw = page.locator("#draw-card");
  const pass = page.locator("#pass-turn");
  const playable = page.locator(".hand-zone.revealed .hand-card.playable");

  if (await playable.count()) return true;
  if (await draw.count()) {
    const disabled = await draw.isDisabled();
    if (!disabled) return true;
  }
  if (await pass.count()) {
    const disabled = await pass.isDisabled();
    if (!disabled) return true;
  }

  return false;
}

async function waitUntilCanAct(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canAct(page)) return;
    await page.waitForTimeout(200);
  }
  throw new Error("Player never became actionable on this client.");
}

async function maybePickWildColor(page) {
  const wildButtons = page.locator("#wild-modal:not(.hidden) [data-wild-color]");
  if (await wildButtons.count()) {
    await wildButtons.first().click();
  }
}

async function actTurn(page) {
  const playable = page.locator(".hand-zone.revealed .hand-card.playable");
  if (await playable.count()) {
    await playable.first().click();
    await maybePickWildColor(page);
    return "play";
  }

  const draw = page.locator("#draw-card");
  if (await draw.count() && !(await draw.isDisabled())) {
    await draw.click();
    await page.waitForTimeout(350);

    const playableAfterDraw = page.locator(".hand-zone.revealed .hand-card.playable");
    if (await playableAfterDraw.count()) {
      await playableAfterDraw.first().click();
      await maybePickWildColor(page);
      return "draw_play";
    }

    const pass = page.locator("#pass-turn");
    if (await pass.count() && !(await pass.isDisabled())) {
      await pass.click();
      return "draw_pass";
    }

    return "draw";
  }

  const pass = page.locator("#pass-turn");
  if (await pass.count() && !(await pass.isDisabled())) {
    await pass.click();
    return "pass";
  }

  return "none";
}

test.describe("online multiplayer", () => {
  test("host and joiner can both act when turn changes", async ({ browser, baseURL }) => {
    test.skip(!hasAuthStates(), "Missing tests/.auth/host.json or tests/.auth/joiner.json. Run npm run e2e:auth:host and npm run e2e:auth:joiner first.");

    const appUrl = process.env.E2E_BASE_URL || baseURL || "http://127.0.0.1:3000";

    const hostContext = await browser.newContext({ storageState: path.resolve(HOST_STATE) });
    const joinerContext = await browser.newContext({ storageState: path.resolve(JOINER_STATE) });

    const host = await hostContext.newPage();
    const joiner = await joinerContext.newPage();

    try {
      await openSetupOnline(host, appUrl);
      await openSetupOnline(joiner, appUrl);

      await host.locator('input[data-name-index="0"]').fill(`Host-${Date.now().toString().slice(-4)}`);
      await joiner.locator('input[data-name-index="0"]').fill(`Joiner-${Date.now().toString().slice(-4)}`);

      await host.selectOption("#player-count", "2");
      await host.locator('[data-online-action="create-room"]').click();

      const roomCode = await waitForRoomCode(host);

      await joiner.locator("#room-code-input").fill(roomCode);
      await joiner.locator('[data-online-action="join-room"]').click();

      await expect(host.locator("#players-grid")).toBeVisible({ timeout: 30000 });
      await expect(joiner.locator("#players-grid")).toBeVisible({ timeout: 30000 });

      await expect
        .poll(async () => await joiner.locator(".hand-zone.revealed .hand-card").count(), {
          timeout: 15000,
        })
        .toBeGreaterThan(0);

      await waitUntilCanAct(host, 25000);
      const hostAction = await actTurn(host);
      expect(hostAction).not.toBe("none");

      await waitUntilCanAct(joiner, 25000);
      const joinerAction = await actTurn(joiner);
      expect(joinerAction).not.toBe("none");

      const joinerToast = (await joiner.locator("#toast-alert").textContent()) || "";
      expect(joinerToast).not.toContain("You are not seated in this room");
    } finally {
      await hostContext.close();
      await joinerContext.close();
    }
  });
});
