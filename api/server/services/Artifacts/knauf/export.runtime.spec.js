const http = require('node:http');
const { existsSync } = require('node:fs');
const sharp = require('sharp');
const { renderArtifact } = require('./export');

const LONG_PAGE_HEIGHT = 3200;
const chromiumPath = [
  process.env.CHROMIUM_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/app/knauf/docker/chromium-wrapper.sh',
].find((path) => path && existsSync(path));

const frame = `<!doctype html>
<html>
  <body style="margin:0">
    <main style="height:${LONG_PAGE_HEIGHT}px;background:#fff">
      <div style="height:${LONG_PAGE_HEIGHT - 200}px;background:#fff">Top</div>
      <div style="height:200px;background:#e4002b">Bottom marker</div>
    </main>
  </body>
</html>`;

const paginatedFrame = `<!doctype html>
<html>
  <body style="margin:0"></body>
  <script>
    const total = 12;
    let page = 1;
    const render = () => {
      const height = page === 11 ? 1200 : 900;
      document.body.innerHTML =
        '<main style="min-height:' + height + 'px;background:#fff;padding:24px">' +
        '<p>Section ' + page + ' / ' + total + '</p>' +
        '<div style="height:' + (height - 160) + 'px">Content ' + page + '</div>' +
        '<nav>' +
        Array.from({ length: total }, (_, index) => {
          const target = index + 1;
          return '<button type="button" data-page="' + target + '"' +
            (target === page ? ' disabled' : '') + '>' + target + '</button>';
        }).join('') +
        '</nav></main>';
      for (const button of document.querySelectorAll('button[data-page]')) {
        button.addEventListener('click', () => {
          page = Number(button.dataset.page);
          render();
        });
      }
    };
    render();
  </script>
</html>`;

const shell = `<!doctype html>
<html>
  <body style="margin:0">
    <div data-knauf-artifact-export style="height:900px;overflow:hidden">
      <iframe src="/frame" style="display:block;width:100%;height:900px;border:0"></iframe>
    </div>
  </body>
</html>`;

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });

(chromiumPath ? describe : describe.skip)(
  'artifact renderer real-browser long-page regression',
  () => {
    jest.setTimeout(60_000);

    let server;
    let activeFrame;
    let previousBaseUrl;
    let previousChromiumPath;

    beforeAll(async () => {
      previousBaseUrl = process.env.ARTIFACT_EXPORT_BASE_URL;
      previousChromiumPath = process.env.CHROMIUM_PATH;
      process.env.CHROMIUM_PATH = chromiumPath;
      activeFrame = frame;
      server = http.createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(request.url === '/frame' ? activeFrame : shell);
      });
      const port = await listen(server);
      process.env.ARTIFACT_EXPORT_BASE_URL = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      if (previousChromiumPath == null) {
        delete process.env.CHROMIUM_PATH;
      } else {
        process.env.CHROMIUM_PATH = previousChromiumPath;
      }
      if (previousBaseUrl == null) {
        delete process.env.ARTIFACT_EXPORT_BASE_URL;
      } else {
        process.env.ARTIFACT_EXPORT_BASE_URL = previousBaseUrl;
      }
      await close(server);
    });

    it('keeps the bottom of a long page in PNG and the PDF image', async () => {
      const artifact = { title: 'Long dashboard', type: 'text/html', content: '<main>Long</main>' };
      const png = await renderArtifact(artifact, 'png');
      const pdf = await renderArtifact(artifact, 'pdf');

      const pngMetadata = await sharp(png.buffer).metadata();
      expect(pngMetadata).toMatchObject({ width: 1440, height: LONG_PAGE_HEIGHT });
      const pngBottomBuffer = await sharp(png.buffer)
        .extract({ left: 0, top: LONG_PAGE_HEIGHT - 100, width: 1440, height: 100 })
        .toBuffer();
      const pngBottom = await sharp(pngBottomBuffer).stats();
      expect(pngBottom.channels[0].mean).toBeGreaterThan(200);
      expect(pngBottom.channels[1].mean).toBeLessThan(80);

      const pdfSource = pdf.buffer.toString('latin1');
      expect(pdfSource).toMatch(/\/MediaBox\s*\[0 0 1080 2400\]/);
      expect(pdfSource).toMatch(/\/Width\s+1440\s*\/Height\s+3200/);
    });

    it('exports every state from a structurally paginated artifact', async () => {
      activeFrame = paginatedFrame;
      try {
        const artifact = {
          title: 'Interactive training',
          type: 'application/vnd.react',
          content: '<main>Training</main>',
        };
        const pdf = await renderArtifact(artifact, 'pdf');
        const pdfSource = pdf.buffer.toString('latin1');

        expect(pdfSource.match(/\/Type\s*\/Page\b/g)).toHaveLength(12);
        expect(pdfSource).toMatch(/\/Width\s+1440\s*\/Height\s+1248/);
      } finally {
        activeFrame = frame;
      }
    });
  },
);
