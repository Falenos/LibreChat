const { randomBytes, timingSafeEqual } = require('crypto');
const { existsSync } = require('fs');
const { chromium } = require('playwright-core');
const { ALLOWED_ARTIFACT_TYPES, MAX_ARTIFACT_BYTES, extractDirectiveContent } = require('./share');

const EXPORT_TIMEOUT_MS = 30_000;
const MAX_ACTIVE_EXPORTS = 2;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_ARTIFACT_PAGES = 20;
const MAX_PNG_HEIGHT = 12_000;
const SNAPSHOT_TTL_MS = 60_000;
const VIEWPORT = { width: 1440, height: 900 };
const snapshots = new Map();
let activeExports = 0;

class ArtifactExportError extends Error {
  constructor(message, status = 400, options) {
    super(message, options);
    this.name = 'ArtifactExportError';
    this.status = status;
  }
}

const validateArtifact = (artifact) => {
  if (!artifact || typeof artifact !== 'object') {
    throw new ArtifactExportError('Artifact is required');
  }
  if (!ALLOWED_ARTIFACT_TYPES.has(artifact.type)) {
    throw new ArtifactExportError('Unsupported artifact type');
  }
  if (typeof artifact.content !== 'string' || !artifact.content) {
    throw new ArtifactExportError('Artifact content is required');
  }
  if (Buffer.byteLength(artifact.content, 'utf8') > MAX_ARTIFACT_BYTES) {
    throw new ArtifactExportError('Artifact is too large to export', 413);
  }

  return {
    title: String(artifact.title || 'Generated artifact').slice(0, 240),
    type: artifact.type,
    content: extractDirectiveContent(artifact.content, artifact.type),
    ...(typeof artifact.language === 'string' && artifact.language
      ? { language: artifact.language.slice(0, 80) }
      : {}),
  };
};

const sameSecret = (actual, expected) => {
  if (typeof actual !== 'string' || actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
};

const getRenderSnapshot = (token, secret) => {
  const snapshot = snapshots.get(token);
  if (!snapshot || snapshot.expiresAt < Date.now() || !sameSecret(secret, snapshot.secret)) {
    snapshots.delete(token);
    throw new ArtifactExportError('Export snapshot not found', 404);
  }
  return snapshot.artifact;
};

const clientBasePath = () => {
  try {
    const path = new URL(process.env.DOMAIN_CLIENT || 'http://localhost').pathname;
    return path === '/' ? '' : path.replace(/\/$/, '');
  } catch {
    return '';
  }
};

const exportPageUrl = (token, secret) => {
  const origin =
    process.env.ARTIFACT_EXPORT_BASE_URL || `http://localhost:${process.env.PORT || 3080}`;
  return `${origin.replace(/\/$/, '')}${clientBasePath()}/artifact-export/${token}#${secret}`;
};

const chromiumExecutable = () => {
  if (process.env.CHROMIUM_PATH) {
    return process.env.CHROMIUM_PATH;
  }
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'darwin' && existsSync(macChrome)) {
    return macChrome;
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return '/app/knauf/docker/chromium-wrapper.sh';
  }
  return existsSync('/usr/bin/chromium-browser')
    ? '/usr/bin/chromium-browser'
    : '/usr/bin/chromium';
};

const allowedHosts = () => {
  const hosts = new Set(['cdn.tailwindcss.com', 'cdn.jsdelivr.net', 'data.jsdelivr.com']);
  for (const value of [process.env.SANDPACK_BUNDLER_URL, process.env.SANDPACK_STATIC_BUNDLER_URL]) {
    try {
      if (value) {
        hosts.add(new URL(value).hostname);
      }
    } catch {
      // Invalid optional URL: keep the fixed safe allowlist.
    }
  }
  return hosts;
};

const isAllowedRequest = (value, localOrigin, hosts) => {
  if (/^(about:|blob:|data:)/.test(value)) {
    return true;
  }
  try {
    const url = new URL(value);
    return (
      url.origin === localOrigin ||
      hosts.has(url.hostname) ||
      url.hostname === 'codesandbox.io' ||
      url.hostname.endsWith('.codesandbox.io')
    );
  } catch {
    return false;
  }
};

const configureNetworkBoundary = async (context, localOrigin) => {
  const hosts = allowedHosts();
  await context.route('**/*', (route) =>
    isAllowedRequest(route.request().url(), localOrigin, hosts)
      ? route.continue()
      : route.abort('blockedbyclient'),
  );
  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket('**/*', (socket) =>
      isAllowedRequest(socket.url(), localOrigin, hosts)
        ? socket.connectToServer()
        : socket.close({ code: 1008, reason: 'Blocked by artifact export policy' }),
    );
  }
};

const expectsSlideContract = (artifact) =>
  artifact.content.includes('/knauf/slides') ||
  artifact.content.includes('data-knauf-export-pages');

const waitForSandboxReady = async (page) => {
  try {
    await page.waitForFunction(
      () => {
        const loading =
          /\[\d+\/\d+\]\s+(?:Downloading manifest|Downloaded .+ \(\d+\/\d+\)|Starting)/m;
        const root = document.querySelector('[data-knauf-artifact-export]');
        const overlay = root?.querySelector('.sp-overlay.sp-loading, .sp-overlay.sp-error');
        return (
          Boolean(root?.querySelector('iframe')) && !overlay && !loading.test(root?.innerText ?? '')
        );
      },
      undefined,
      { timeout: EXPORT_TIMEOUT_MS },
    );
  } catch (error) {
    throw new ArtifactExportError('Artifact preview did not become ready', 500, { cause: error });
  }
};

const waitForStablePreview = async (previewFrame, requireSlideContract) => {
  try {
    await previewFrame.waitForFunction(
      (requiresContract) => {
        const loading =
          /\[\d+\/\d+\]\s+(?:Downloading manifest|Downloaded .+ \(\d+\/\d+\)|Starting)/m;
        const body = document.body;
        const text = body?.innerText ?? '';
        const markup = body?.innerHTML ?? '';
        const now = performance.now();
        const state = window.__knaufArtifactExportState;
        const contract = document.querySelector('[data-knauf-export-pages]');
        const contractButton = document.querySelector('[data-knauf-export-next]');
        const contractPages = Number(contract?.getAttribute('data-knauf-export-pages'));
        const hasValidContract =
          Number.isInteger(contractPages) &&
          contractPages > 0 &&
          (contractPages === 1 || contractButton);

        if (
          !body?.childElementCount ||
          loading.test(text) ||
          (requiresContract && !hasValidContract)
        ) {
          window.__knaufArtifactExportState = { markup: '', since: now };
          return false;
        }
        if (!state || state.markup !== markup) {
          window.__knaufArtifactExportState = { markup, since: now };
          return false;
        }
        return now - state.since >= 1500;
      },
      requireSlideContract,
      { timeout: EXPORT_TIMEOUT_MS },
    );
  } catch (error) {
    throw new ArtifactExportError('Artifact preview did not become ready', 500, { cause: error });
  }
};

const fitPreviewFrame = async (page, previewFrame, requireSlideContract) => {
  let height = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    await previewFrame.evaluate(async () => document.fonts?.ready);
    const contentHeight = await previewFrame.evaluate(() =>
      Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    );
    const nextHeight = Math.min(MAX_PNG_HEIGHT, Math.max(VIEWPORT.height, height, contentHeight));
    if (nextHeight === height) {
      break;
    }
    height = nextHeight;
    await page.setViewportSize({ width: VIEWPORT.width, height });
    await page.evaluate((fittedHeight) => {
      const id = 'knauf-artifact-export-frame-fit';
      const style = document.getElementById(id) ?? document.createElement('style');
      style.id = id;
      style.textContent = `[data-knauf-artifact-export]{height:${fittedHeight}px!important;min-height:${fittedHeight}px!important;overflow:visible!important}[data-knauf-artifact-export] iframe{height:${fittedHeight}px!important;max-height:none!important;flex:none!important}`;
      if (!style.isConnected) {
        document.head.appendChild(style);
      }
    }, height);
    await waitForSandboxReady(page);
    await waitForStablePreview(previewFrame, requireSlideContract);
  }
  return height;
};

const getPreviewPageCount = (previewFrame, requireSlideContract) =>
  previewFrame.evaluate((requiresContract) => {
    const contract = document.querySelector('[data-knauf-export-pages]');
    const contractButton = document.querySelector('[data-knauf-export-next]');
    const contractPages = Number(contract?.getAttribute('data-knauf-export-pages'));
    if (
      Number.isInteger(contractPages) &&
      contractPages > 0 &&
      (contractPages === 1 || contractButton)
    ) {
      return contractPages;
    }
    if (requiresContract) {
      return 0;
    }
    const nextButton = [...document.querySelectorAll('button')].find((button) =>
      /^next\b/i.test((button.getAttribute('aria-label') || button.textContent || '').trim()),
    );
    if (!nextButton || nextButton.disabled) {
      return 1;
    }
    const counter = [...document.querySelectorAll('body *')].find(
      (element) =>
        element.childElementCount === 0 && /^1\s*\/\s*\d+$/.test(element.textContent?.trim() ?? ''),
    );
    return Number(counter?.textContent?.trim().match(/^1\s*\/\s*(\d+)$/)?.[1]) || 1;
  }, requireSlideContract);

const advancePreviewPage = (previewFrame) =>
  previewFrame.evaluate(() => {
    const button =
      document.querySelector('[data-knauf-export-next]') ||
      [...document.querySelectorAll('button')].find((candidate) =>
        /^next\b/i.test(
          (candidate.getAttribute('aria-label') || candidate.textContent || '').trim(),
        ),
      );
    if (!button || button.disabled) {
      return false;
    }
    window.__knaufArtifactExportState = { markup: '', since: performance.now() };
    button.click();
    return true;
  });

const renderArtifact = async (input, format) => {
  const artifact = validateArtifact(input);
  if (format !== 'png' && format !== 'pdf') {
    throw new ArtifactExportError('Export format must be png or pdf');
  }
  if (activeExports >= MAX_ACTIVE_EXPORTS) {
    throw new ArtifactExportError('Artifact renderer is busy. Try again later', 429);
  }

  activeExports += 1;
  const token = randomBytes(18).toString('hex');
  const secret = randomBytes(24).toString('hex');
  snapshots.set(token, { artifact, secret, expiresAt: Date.now() + SNAPSHOT_TTL_MS });
  let browser;
  let context;
  try {
    const pageUrl = exportPageUrl(token, secret);
    const requireSlideContract = expectsSlideContract(artifact);
    browser = await chromium.launch({
      headless: true,
      executablePath: chromiumExecutable(),
      timeout: EXPORT_TIMEOUT_MS,
    });
    context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    context.setDefaultTimeout(EXPORT_TIMEOUT_MS);
    await configureNetworkBoundary(context, new URL(pageUrl).origin);
    const page = await context.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: EXPORT_TIMEOUT_MS });
    const iframe = page.locator('[data-knauf-artifact-export] iframe');
    await iframe.waitFor({ state: 'visible', timeout: EXPORT_TIMEOUT_MS });
    await waitForSandboxReady(page);
    const iframeHandle = await iframe.elementHandle();
    const previewFrame = await iframeHandle?.contentFrame();
    if (!previewFrame) {
      throw new ArtifactExportError('Artifact preview did not start', 500);
    }
    await waitForStablePreview(previewFrame, requireSlideContract);
    const height = await fitPreviewFrame(page, previewFrame, requireSlideContract);
    const pageCount = await getPreviewPageCount(previewFrame, requireSlideContract);
    if (pageCount < 1) {
      throw new ArtifactExportError('Artifact preview did not become ready', 500);
    }
    if (
      pageCount > MAX_ARTIFACT_PAGES ||
      (format === 'png' && height * pageCount > MAX_PNG_HEIGHT)
    ) {
      throw new ArtifactExportError('Artifact has too many pages to export', 413);
    }
    const screenshots = [];
    let screenshotBytes = 0;
    for (let index = 0; index < pageCount; index += 1) {
      if (index > 0) {
        if (!(await advancePreviewPage(previewFrame))) {
          throw new ArtifactExportError('Artifact page navigation failed', 500);
        }
        await waitForStablePreview(previewFrame, requireSlideContract);
        await previewFrame.evaluate(async () => document.fonts?.ready);
      }
      const screenshot = Buffer.from(await page.screenshot({ type: 'png', fullPage: true }));
      screenshotBytes += screenshot.length;
      if (screenshotBytes > MAX_OUTPUT_BYTES) {
        throw new ArtifactExportError('Rendered artifact is too large', 413);
      }
      screenshots.push(screenshot);
    }
    let output = screenshots[0];
    if (format === 'pdf' || screenshots.length > 1) {
      const images = screenshots
        .map(
          (screenshot) =>
            `<img src="data:image/png;base64,${screenshot.toString('base64')}" alt="">`,
        )
        .join('');
      await page.setContent(
        `<style>@page{size:${VIEWPORT.width}px ${height}px;margin:0}html,body{margin:0;width:${VIEWPORT.width}px}img{display:block;width:${VIEWPORT.width}px;height:${height}px;break-after:page}img:last-child{break-after:auto}</style>${images}`,
        { waitUntil: 'load', timeout: EXPORT_TIMEOUT_MS },
      );
      output =
        format === 'pdf'
          ? await page.pdf({
              width: `${VIEWPORT.width}px`,
              height: `${height}px`,
              margin: { top: 0, right: 0, bottom: 0, left: 0 },
              printBackground: true,
            })
          : await page.screenshot({ type: 'png', fullPage: true });
    }
    const buffer = Buffer.from(output);
    if (buffer.length > MAX_OUTPUT_BYTES) {
      throw new ArtifactExportError('Rendered artifact is too large', 413);
    }
    return {
      buffer,
      mime: format === 'png' ? 'image/png' : 'application/pdf',
      extension: format,
    };
  } catch (error) {
    if (error instanceof ArtifactExportError) {
      throw error;
    }
    throw new ArtifactExportError('Artifact renderer failed', 500, { cause: error });
  } finally {
    snapshots.delete(token);
    activeExports -= 1;
    try {
      await context?.close();
    } catch {
      // Preserve the render result/error when cleanup itself fails.
    }
    try {
      await browser?.close();
    } catch {
      // Preserve the render result/error when cleanup itself fails.
    }
  }
};

module.exports = {
  ArtifactExportError,
  getRenderSnapshot,
  renderArtifact,
};
