import { expect, test } from '@playwright/test';
import { getPrimaryE2EUser } from '../../setup/users.mock';
import { NEW_CHAT_PATH } from './helpers';

test.describe('Knauf core smoke', () => {
  test('loads the authenticated Karl shell and keeps the session across reload', async ({ page }) => {
    const user = getPrimaryE2EUser();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

    await expect(page).toHaveURL(/\/c\/new$/);
    await expect(page.getByRole('main')).toContainText(user.name);
    await expect(page.getByRole('button', { name: 'Select Agent' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();

    await page.reload({ timeout: 10000 });

    await expect(page).toHaveURL(/\/c\/new$/);
    await expect(page.getByRole('main')).toContainText(user.name);
    await expect(page.getByRole('button', { name: 'Select Agent' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    expect(pageErrors, `Unexpected runtime errors: ${pageErrors.join(', ')}`).toHaveLength(0);
  });
});
