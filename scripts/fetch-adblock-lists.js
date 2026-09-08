const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

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

// Plain https instead of global fetch: when a list server drops the TLS
// connection mid-body, Node 24's undici can die on an internal assertion
// (`assert(!this.paused)`) that surfaces as an uncaught exception, outside
// any try/catch — the v0.8.5-rc.1 release run failed exactly that way. The
// https client reports the same condition as a catchable 'error', so the
// retry loop below actually gets a chance to run.
function download(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Freedom-Adblock-Fetcher' } }, (res) => {
      const { statusCode, headers } = res;
      if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
        res.resume();
        if (redirectsLeft === 0) return reject(new Error(`${url}: too many redirects`));
        return resolve(download(new URL(headers.location, url).href, redirectsLeft - 1));
      }
      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`${url} responded ${statusCode}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error(`${url}: connection closed mid-response`)));
      res.on('end', () => {
        if (!res.complete) return reject(new Error(`${url}: response truncated`));
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });
    });
    req.setTimeout(60_000, () => req.destroy(new Error(`${url}: timed out`)));
    req.on('error', reject);
  });
}

async function withRetries(label, fn, maxAttempts = 4) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delayMs = 2000 * attempt;
        console.warn(
          `\n${label} attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms...`
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

async function fetchList(category, meta) {
  const text = await withRetries(`${meta.title} download`, () => download(meta.sourceUrl));
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
