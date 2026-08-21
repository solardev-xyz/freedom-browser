const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Fetches the EasyList-family filter lists the adblock service compiles at
// runtime (src/main/adblock/service.js) and writes them, plus a manifest,
// to assets/adblock/. The directory is gitignored and packaged via
// extraResources — run this before a dist build (like ant:download etc.).
//
// The catalog mirrors freedom-adblock-service/sources.json (the iOS artifact
// builder) so both platforms block from the same lists. The Swarm-distributed
// update channel will publish these same artifacts; bundled copies are the
// offline/first-launch fallback.
//
// EasyList/EasyPrivacy are dual-licensed GPLv3+ / CC BY-SA 3.0+; Freedom
// redistributes under CC BY-SA with attribution (see NOTICES).
const OUTPUT_DIR = path.join(__dirname, '..', 'assets', 'adblock');

const CATEGORIES = {
  ads: {
    file: 'easylist.txt',
    title: 'EasyList',
    sourceUrl: 'https://easylist.to/easylist/easylist.txt',
    license: 'GPLv3+ / CC BY-SA 3.0+',
  },
  privacy: {
    file: 'easyprivacy.txt',
    title: 'EasyPrivacy',
    sourceUrl: 'https://easylist.to/easylist/easyprivacy.txt',
    license: 'GPLv3+ / CC BY-SA 3.0+',
  },
  cookies: {
    file: 'easylist-cookies.txt',
    title: 'Fanboy Cookiemonster',
    sourceUrl: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt',
    license: 'GPLv3+ / CC BY-SA 3.0+',
  },
  annoyances: {
    file: 'easylist-annoyances.txt',
    title: 'Fanboy Annoyances',
    sourceUrl: 'https://secure.fanboy.co.nz/fanboy-annoyance.txt',
    license: 'GPLv3+ / CC BY-SA 3.0+',
  },
};

function countRules(text) {
  let count = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('!') && !trimmed.startsWith('[')) count++;
  }
  return count;
}

async function fetchList(category, meta) {
  const res = await fetch(meta.sourceUrl, {
    headers: { 'User-Agent': 'Freedom-Adblock-Fetcher' },
  });
  if (!res.ok) {
    throw new Error(`${meta.sourceUrl} responded ${res.status}`);
  }
  const text = await res.text();
  if (!text.includes('[Adblock')) {
    throw new Error(`${meta.sourceUrl} does not look like an ABP filter list`);
  }
  return text;
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const manifest = {
    version: new Date().toISOString().slice(0, 10),
    fetchedAt: new Date().toISOString(),
    categories: {},
  };

  for (const [category, meta] of Object.entries(CATEGORIES)) {
    process.stdout.write(`Fetching ${meta.title} (${category})... `);
    const text = await fetchList(category, meta);
    fs.writeFileSync(path.join(OUTPUT_DIR, meta.file), text, 'utf-8');
    manifest.categories[category] = {
      file: meta.file,
      title: meta.title,
      sourceUrl: meta.sourceUrl,
      license: meta.license,
      sha256: crypto.createHash('sha256').update(text).digest('hex'),
      bytes: Buffer.byteLength(text),
      ruleCount: countRules(text),
    };
    console.log(`${manifest.categories[category].ruleCount} rules`);
  }

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8'
  );
  console.log(`\n✅ Wrote ${Object.keys(CATEGORIES).length} lists + manifest to ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
