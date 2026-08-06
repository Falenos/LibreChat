import { expect, test } from '@playwright/test';
import { NEW_CHAT_PATH, messagesView, sendMessage } from './helpers';

const ARTIFACT_TITLE = 'E2E React Artifact';
const ARTIFACT_SOURCE = `export default function App() {
  return <main data-testid="e2e-artifact-preview">E2E artifact preview</main>;
}`;

test.describe('artifacts', () => {
  test('ART-GEN-001 ART-GEN-003 ART-GEN-005 ART-PRE-001 ART-PRE-002 ART-DL-001 ART-OPS-005 @artifact-pr', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const requestFailures: string[] = [];
    const badResponses: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
      const failure = request.failure()?.errorText ?? 'unknown';
      if (!failure.includes('ERR_ABORTED')) {
        requestFailures.push(`${request.method()} ${request.url()} ${failure}`);
      }
    });
    page.on('response', (response) => {
      if ([401, 403].includes(response.status()) || response.status() >= 500) {
        badResponses.push(`${response.request().method()} ${response.url()} ${response.status()}`);
      }
    });

    await page.goto(NEW_CHAT_PATH);
    await sendMessage(page, 'E2E_ARTIFACT_REPLY');

    const messages = messagesView(page);
    const artifactCard = messages.getByRole('button', { name: new RegExp(ARTIFACT_TITLE) });
    await expect(messages.getByText('Created the E2E artifact.')).toBeVisible({ timeout: 30000 });
    await expect(artifactCard).toHaveCount(1);
    await expect(messages).not.toContainText(':::artifact');
    await expect(messages).not.toContainText(ARTIFACT_SOURCE);

    await artifactCard.click();
    await expect(page.getByRole('radio', { name: 'Preview' })).toBeChecked();
    const previewFrame = page.frameLocator('iframe[title="Sandpack Preview"]');
    const preview = previewFrame.locator('main');
    await expect(preview).toHaveText('E2E artifact preview', { timeout: 30000 });
    await expect(previewFrame.locator('body')).not.toContainText(
      /ModuleNotFoundError|SyntaxError|is not a function|Cannot find module/i,
    );
    await expect(page.getByRole('button', { name: 'Fix artifact' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await artifactCard.click();
    await expect(preview).toHaveText('E2E artifact preview', { timeout: 30000 });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(preview).toHaveText('E2E artifact preview', { timeout: 30000 });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await artifactCard.click();
    await expect(preview).toHaveText('E2E artifact preview', { timeout: 30000 });

    await page.getByRole('button', { name: 'Download Artifact' }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: 'Source file' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('App.tsx');
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe(`${ARTIFACT_SOURCE}\n`);
    expect(pageErrors, `Unexpected runtime errors: ${pageErrors.join(', ')}`).toHaveLength(0);
    expect(consoleErrors, `Unexpected console errors: ${consoleErrors.join(', ')}`).toHaveLength(0);
    expect(
      requestFailures,
      `Unexpected request failures: ${requestFailures.join(', ')}`,
    ).toHaveLength(0);
    expect(badResponses, `Unexpected error responses: ${badResponses.join(', ')}`).toHaveLength(0);
  });
});
