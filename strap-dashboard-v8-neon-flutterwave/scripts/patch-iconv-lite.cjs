const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'node_modules');
let patched = 0;

function patchPackage(dir) {
  const manifest = path.join(dir, 'package.json');
  if (!fs.existsSync(manifest)) return;
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

function visitNodeModules(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === 'iconv-lite') patchPackage(full);
    if (entry.name === 'node_modules' || entry.name.startsWith('@')) {
      visitNodeModules(full);
    } else {
      const nested = path.join(full, 'node_modules');
      if (fs.existsSync(nested)) visitNodeModules(nested);
    }
  }
}

visitNodeModules(root);
console.log(`[patch-iconv-lite] Removed incompatible browser stream stubs from ${patched} package copy/copies.`);
