const fs = require('fs-extra');

async function postBuild() {
  try {
    await fs.copy('public/assets', 'dist/assets');
    await fs.copy('public/robots.txt', 'dist/robots.txt');
    // [knauf] KK20-250 — ship the canonical help page so the in-app dialog and direct URL resolve.
    await fs.copy('public/help', 'dist/help');
    console.log(
      '✅ PWA icons, robots.txt, and KARL help copied successfully. Glob pattern warnings resolved.',
    );
    // End [knauf]
  } catch (err) {
    console.error('❌ Error copying files:', err);
    process.exit(1);
  }
}

postBuild();
