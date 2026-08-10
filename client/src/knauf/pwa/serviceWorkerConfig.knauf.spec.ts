import fs from 'fs';
import path from 'path';

const readViteConfig = () =>
  fs.readFileSync(path.join(__dirname, '../../../vite.config.ts'), 'utf8');

describe('[knauf] service worker update safety', () => {
  it('does not ship the activation-time client reload script', () => {
    const config = readViteConfig();

    expect(config).not.toContain('emit-sw-heal');
    expect(config).not.toContain('sw-heal.js');
  });
});
