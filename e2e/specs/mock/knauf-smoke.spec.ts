import { expect, test } from '@playwright/test';
import { getPrimaryE2EUser } from '../../setup/users.mock';
import { NEW_CHAT_PATH, messagesView, replyPrompt, replyText, sendMessage } from './helpers';

test.describe('Knauf core smoke', () => {
  test('loads Karl, completes a default chat, and persists it across reload', async ({ page }) => {
    const user = getPrimaryE2EUser();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

    await expect(page).toHaveURL(/\/c\/new$/);
    await expect(page.getByRole('main')).toContainText(user.name);
    await expect(page.getByRole('button', { name: 'Select Agent' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();

    const label = `knauf-smoke-${Date.now()}`;
    const prompt = replyPrompt(label);
    const reply = replyText(label);
    const response = await sendMessage(page, prompt);

    expect(response.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(prompt)).toBeVisible();
    await expect(messagesView(page).getByText(reply)).toBeVisible({ timeout: 30000 });
    await expect(page).toHaveURL(/\/c\/(?!new)/);
    const conversationUrl = page.url();

    await page.reload({ timeout: 10000 });

    await expect(page).toHaveURL(conversationUrl);
    await expect(messagesView(page).getByText(prompt)).toBeVisible();
    await expect(messagesView(page).getByText(reply)).toBeVisible();
    expect(pageErrors, `Unexpected runtime errors: ${pageErrors.join(', ')}`).toHaveLength(0);
  });
});
