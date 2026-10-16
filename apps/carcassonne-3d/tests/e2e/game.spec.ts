import { expect, test, type Download, type Page } from '@playwright/test';

const seed = 'POSTMAN_TEST_0042';

async function startGame(page: Page, players: number): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('start-game')).toBeVisible();
  await page.getByTestId('seed-input').fill(seed);
  // The player count is rendered as an output, not a form field.
  await expect(page.getByRole('group', { name: 'Число игроков' }).locator('output')).toHaveText('2');
  for (let i = 2; i < players; i += 1) {
    await page.getByRole('button', { name: 'Добавить игрока' }).click();
  }
  await expect(page.getByRole('group', { name: 'Число игроков' }).locator('output')).toHaveText(String(players));
  await page.getByTestId('start-game').click();
  await expect(page.getByTestId('current-player')).toBeVisible();
  await expect(page.getByTestId('legal-placement').first()).toBeVisible();
}

async function playOneTurn(page: Page): Promise<void> {
  await expect(page.getByTestId('legal-placement').first()).toBeEnabled();
  await page.getByTestId('legal-placement').first().click();
  await expect(page.getByTestId('skip-meeple')).toBeVisible();
  await page.getByTestId('skip-meeple').click();
}

async function captureDownload(page: Page): Promise<Download> {
  const download = page.waitForEvent('download');
  await page.getByTestId('save-game').click();
  return download;
}

test('starts real hotseat games with two and five players', async ({ page }) => {
  await startGame(page, 2);
  await expect(page.getByTestId('current-player')).toContainText('Игрок');
  await page.getByRole('button', { name: 'Новая партия' }).click();
  await page.getByTestId('confirm-restart').click();
  await expect(page.getByTestId('start-game')).toBeVisible();
  await startGame(page, 5);
  await expect(page.getByTestId('current-player')).toContainText('Игрок');
});

test('rotates, places a legal tile, places a legal meeple or skips, then advances', async ({ page }) => {
  await startGame(page, 2);
  await page.getByTestId('rotate-right').click();
  await expect(page.getByText('90°', { exact: true }).first()).toBeVisible();
  await page.getByTestId('legal-placement').first().click();
  const target = page.getByTestId('meeple-target');
  if (await target.count()) await target.first().click();
  else await page.getByTestId('skip-meeple').click();
  await expect(page.getByTestId('current-player')).toContainText('Игрок 2');
  await expect(page.getByTestId('legal-placement').first()).toBeEnabled();
  // Legal placement choices are the UI's only placement actions; the UI does
  // not expose an illegal command path, so rejection belongs to engine tests.
});

test('downloads a save, restores it, and keeps the active game after corrupt import', async ({ page }) => {
  await startGame(page, 2);
  const download = await captureDownload(page);
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  const save = await download.createReadStream();
  let json = '';
  for await (const chunk of save) json += chunk.toString();
  const saved = JSON.parse(json) as { commands?: unknown[] };
  expect(saved).toBeTruthy();

  await page.getByTestId('legal-placement').first().click();
  await page.getByTestId('skip-meeple').click();
  const playerBeforeCorruptLoad = {
    turn: (await page.getByTestId('current-player').locator('.eyebrow').textContent())?.replace(/\s+/g, ' ').trim(),
    name: (await page.getByTestId('current-player').locator('strong').textContent())?.trim(),
    heraldry: (await page.getByTestId('current-player').locator('.turn-identity__heraldry').textContent())?.trim(),
  };

  await page.getByTestId('load-game').click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'corrupt.json', mimeType: 'application/json', buffer: Buffer.from('{ definitely not json'),
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('current-player').locator('.eyebrow')).toHaveText(playerBeforeCorruptLoad.turn);
  await expect(page.getByTestId('current-player').locator('strong')).toHaveText(playerBeforeCorruptLoad.name);
  await expect(page.getByTestId('current-player').locator('.turn-identity__heraldry')).toHaveText(playerBeforeCorruptLoad.heraldry);

  await page.getByTestId('load-game').click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'saved.json', mimeType: 'application/json', buffer: Buffer.from(json),
  });
  await expect(page.getByText(/Партия из файла проверена и восстановлена/)).toBeVisible();
  await expect(page.getByTestId('current-player')).toContainText('Игрок');
  await expect(page.getByTestId('legal-placement').first()).toBeEnabled();
});

test('same seed and same UI actions produce the same pending tile sequence', async ({ page }) => {
  const sequence = async (): Promise<string[]> => {
    await startGame(page, 2);
    const ids: string[] = [];
    for (let turn = 0; turn < 8; turn += 1) {
      ids.push((await page.locator('.pending-tile dl dd').first().innerText()).trim());
      await playOneTurn(page);
    }
    return ids;
  };
  const first = await sequence();
  await page.getByRole('button', { name: 'Новая партия' }).click();
  await page.getByTestId('confirm-restart').click();
  expect(await sequence()).toEqual(first);
});

test('finishes the real game through legal placement and meeple/skip controls', async ({ page }) => {
  test.setTimeout(180_000);
  await startGame(page, 2);
  for (let action = 0; action < 142; action += 1) {
    if (await page.getByTestId('game-over').count()) break;
    let placements = page.getByTestId('legal-placement');
    for (let rotation = 0; await placements.count() === 0 && rotation < 4; rotation += 1) {
      await page.getByTestId('rotate-right').click();
      placements = page.getByTestId('legal-placement');
    }
    await expect(placements.first()).toBeEnabled();
    await placements.first().click();
    if (await page.getByTestId('game-over').count()) break;
    const targets = page.getByTestId('meeple-target');
    if (await targets.count()) await targets.first().click();
    else await page.getByTestId('skip-meeple').click();
  }
  await expect(page.getByTestId('game-over')).toBeVisible({ timeout: 10_000 });
});

test('TileLab exposes all definitions, four rotations, and adjacent-pair inspection', async ({ page }) => {
  await page.goto('/tile-lab');
  await expect(page.getByRole('heading', { name: 'Лаборатория плиток' })).toBeVisible();
  const definitions = page.getByTestId('lab-definition');
  await expect(definitions).toHaveCount(24);
  await expect(page.getByTestId('lab-rotation')).toHaveCount(4);
  await expect(page.getByRole('heading', { name: 'Совпадение шва' })).toBeVisible();
  await expect(page.getByText(/Типы граней совпадают|Грани несовместимы/)).toBeVisible();
});
