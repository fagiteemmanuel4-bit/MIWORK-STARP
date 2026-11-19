const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'node_modules');
let patched = 0;

function visit(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === 'iconv-lite') {
      const manifest = path.join(full, 'package.json');
      if (fs.existsSync(manifest)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
          if (pkg.browser) {
            delete pkg.browser;
            fs.writeFileSync(manifest, JSON.stringify(pkg, null, 2) + '\n');
            patched++;
          }
        } catch (error) {
          console.warn('[patch-iconv-lite] Could not patch', manifest, error.message);
        }
      }
    }
    if (entry.name !== '.bin' && entry.name !== '.cache') {
      visit(full);
    }
  }
}

visit(root);
console.log(`[patch-iconv-lite] Removed incompatible browser stream stubs from ${patched} package copy/copies.`);
