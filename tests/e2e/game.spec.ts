import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { HOUSE, TREES } from '../../tools/fixture/content.ts';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/generated/cache', import.meta.url));
const fixtureFiles = () =>
  readdirSync(FIXTURE_DIR)
    .filter((f) => f.startsWith('main_file_cache'))
    .map((f) => join(FIXTURE_DIR, f));

interface Debug {
  player(): { x: number; y: number; plane: number; running: boolean; energy: number } | null;
  stats(): { squares: number; vertices: number };
  projectTile(x: number, y: number, plane: number, lift?: number, dx?: number, dy?: number): { x: number; y: number } | null;
  sample(): number[][];
  setCamera(yaw: number, pitch: number, zoom: number): void;
}

declare global {
  interface Window {
    __game: Debug;
  }
}

async function importFixture(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#setup')).toBeVisible();
  await page.locator('#pick-zip').setInputFiles(fixtureFiles());
  await expect(page.locator('#game')).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => window.__game.stats().squares)).toBeGreaterThan(0);
}

const player = (page: Page) => page.evaluate(() => window.__game.player()!);

async function command(page: Page, text: string): Promise<void> {
  await page.keyboard.press('Enter');
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-input').press('Enter');
}

async function clickTile(page: Page, x: number, y: number, button: 'left' | 'right' = 'left', lift = 0.05, dx = 0.5, dy = 0.5) {
  const p = await page.evaluate(([x, y, lift, dx, dy]) => window.__game.projectTile(x, y, 0, lift, dx, dy), [x, y, lift, dx, dy] as const);
  expect(p).not.toBeNull();
  await page.mouse.click(p!.x, p!.y, { button });
}

/** Top-down camera so scenery never hides the tiles we click. */
async function topDown(page: Page) {
  await page.evaluate(() => window.__game.setCamera(0, 1.35, 18));
  await page.waitForTimeout(100);
}

/** Clicks a tile on the minimap (north-up, 4 px per tile, centred on the player). */
async function minimapWalk(page: Page, x: number, y: number) {
  // The minimap is centred on the *displayed* position, which glides for up to one 600 ms tick.
  await page.waitForTimeout(700);
  const me = await player(page);
  const box = (await page.locator('#minimap').boundingBox())!;
  const scale = box.width / 176;
  await page.mouse.click(box.x + box.width / 2 + (x - me.x) * 4 * scale, box.y + box.height / 2 - (y - me.y) * 4 * scale);
}

test('shows the import screen and rejects a non-cache file', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#setup h1')).toHaveText('OSRS Browser');
  await page.locator('#pick-zip').setInputFiles({ name: 'notes.zip', mimeType: 'application/zip', buffer: Buffer.from('definitely not a zip') });
  await expect(page.locator('#setup-error')).toContainText('Not a zip');
});

test('imports a cache and renders the world with WebGL 2', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await importFixture(page);
  await expect(page.locator('#chat-log')).toContainText('Welcome');
  await expect(page.locator('#coords')).toHaveText('3222, 3218, 0');
  const pixels = await page.evaluate(() => window.__game.sample());
  // Grass/path/scenery: the frame must not be a single flat colour.
  const distinct = new Set(pixels.map((p) => p.slice(0, 3).join(',')));
  expect(distinct.size).toBeGreaterThan(3);
  expect(pixels.some(([r, g, b]) => g > r && g > b)).toBe(true); // some grass
  expect(errors).toEqual([]);
});

test('walks to a clicked tile and runs when toggled', async ({ page }) => {
  await importFixture(page);
  await topDown(page);
  await clickTile(page, 3222, 3212);
  await expect.poll(() => player(page), { timeout: 15_000 }).toMatchObject({ x: 3222, y: 3212 });

  await page.locator('#run-orb').click();
  await expect(page.locator('#run-orb')).toHaveAttribute('aria-pressed', 'true', { timeout: 5_000 });
  await clickTile(page, 3222, 3217);
  await expect.poll(() => player(page), { timeout: 15_000 }).toMatchObject({ x: 3222, y: 3217 });
  expect((await player(page)).energy).toBeLessThan(100);

  // The minimap walks too.
  await minimapWalk(page, 3218, 3217);
  await expect.poll(() => player(page), { timeout: 15_000 }).toMatchObject({ x: 3218, y: 3217 });
});

test('trees block movement and offer their options', async ({ page }) => {
  await importFixture(page);
  await topDown(page);
  const tree = TREES[0];
  await clickTile(page, tree.x, tree.y, 'right', 1.2);
  const menu = page.locator('#context-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Chop down Tree');
  await expect(menu).toContainText('Examine Tree');
  await menu.getByRole('menuitem', { name: 'Examine Tree' }).click();
  await expect(page.locator('#chat-log')).toContainText("It's a tree.");
});

test('opens the door, climbs the ladder and keeps progress after reload', async ({ page }) => {
  await importFixture(page);
  await command(page, `::tele ${HOUSE.doorX} ${HOUSE.doorY - 2} 0`);
  await expect.poll(() => player(page)).toMatchObject({ x: HOUSE.doorX, y: HOUSE.doorY - 2, plane: 0 });
  await page.evaluate(() => window.__game.setCamera(0, 0.6, 7));
  await page.waitForTimeout(200);

  // The closed door sits on the south edge of its tile.
  await clickTile(page, HOUSE.doorX, HOUSE.doorY, 'right', 0.7, 0.5, 0.06);
  const menu = page.locator('#context-menu');
  await expect(menu).toContainText('Open Door');
  await menu.getByRole('menuitem', { name: 'Open Door' }).click();
  await expect(page.locator('#chat-log')).toContainText('You open the door.', { timeout: 10_000 });

  // From outside the upper floor covers the house like a roof; walk in (via the minimap) so it hides.
  await minimapWalk(page, HOUSE.doorX, HOUSE.doorY + 1);
  await expect.poll(() => player(page), { timeout: 15_000 }).toMatchObject({ x: HOUSE.doorX, y: HOUSE.doorY + 1 });
  await topDown(page);
  await clickTile(page, HOUSE.ladderX, HOUSE.ladderY, 'right', 0.3);
  await expect(menu).toContainText('Climb-up Ladder');
  await menu.getByRole('menuitem', { name: 'Climb-up Ladder' }).click();
  await expect(page.locator('#chat-log')).toContainText('You climb up.', { timeout: 20_000 });
  await expect.poll(() => player(page)).toMatchObject({ plane: 1 });
  const upstairs = await player(page);

  // Autosave runs every few ticks; reload and expect the same spot without re-importing.
  await page.waitForTimeout(4000);
  await page.reload();
  await expect(page.locator('#game')).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => player(page)).toMatchObject({ x: upstairs.x, y: upstairs.y, plane: 1 });
});

test('camera controls respond to keys, wheel and the compass', async ({ page }) => {
  await importFixture(page);
  const canvas = page.locator('#view');
  await canvas.focus();
  const before = await page.evaluate(() => window.__game.projectTile(3222, 3230, 0));
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(400);
  await page.keyboard.up('ArrowLeft');
  const after = await page.evaluate(() => window.__game.projectTile(3222, 3230, 0));
  expect(after!.x).not.toBeCloseTo(before!.x, 0);
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(100);
  const zoomed = await page.evaluate(() => window.__game.projectTile(3222, 3230, 0));
  expect(zoomed).not.toEqual(after);
  await page.locator('#compass').click();
  // Right-click anywhere opens the game's own menu instead of the browser's.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await expect(page.locator('#context-menu')).toContainText('Cancel');
  await page.keyboard.press('Escape');
  await expect(page.locator('#context-menu')).toBeHidden();
});
