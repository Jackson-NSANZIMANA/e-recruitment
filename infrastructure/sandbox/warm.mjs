// Warms the three dev servers before the browser journeys: the first visit to a cold Vite dev server
// re-optimises dependencies and reloads the page, which a test would otherwise race. Visits each app's
// sign-in page until a form field is on screen (up to 3 minutes each). Usage: node warm.mjs <ui-dir> <url>...
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [ui, ...urls] = process.argv.slice(2);
const require = createRequire(join(ui, 'apps', 'applicant-portal', 'package.json'));
const { chromium } = require('@playwright/test');
const browser = await chromium.launch();
let failed = false;
for (const url of urls) {
  const page = await browser.newPage();
  const until = Date.now() + 180_000;
  let ok = false;
  while (Date.now() < until && !ok) {
    try {
      await page.goto(`${url}/login`, { waitUntil: 'load', timeout: 60_000 });
      await page.locator('input').first().waitFor({ timeout: 30_000 });
      ok = true;
    } catch { await page.waitForTimeout(3_000); }
  }
  console.log(`${ok ? 'warm' : 'NOT WARM'} ${url}`);
  failed ||= !ok;
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
