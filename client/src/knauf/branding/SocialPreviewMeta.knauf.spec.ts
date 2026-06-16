import fs from 'fs';
import path from 'path';

function readIndexHtml(): string {
  return fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
}

describe('[knauf] social preview metadata', () => {
  it('uses the Knauf logo for Open Graph and Twitter preview images', () => {
    const html = readIndexHtml();

    expect(html).toContain(
      '<meta property="og:title" content="Agentic Karl | Knauf AI Platform" />',
    );
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    expect(html).toContain(
      '<meta property="og:image" content="https://agentic-karl.knauf.com/assets/knauf-logo.png" />',
    );
    expect(html).toContain(
      '<meta name="twitter:image" content="https://agentic-karl.knauf.com/assets/knauf-logo.png" />',
    );
    expect(html).not.toContain('content="https://librechat.ai');
  });
});
