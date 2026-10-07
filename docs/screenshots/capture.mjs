// Screenshots of the admin console with headless Chrome (puppeteer-core), from a running stack.
//
//   PUPPETEER_FROM=<dir with node_modules/puppeteer-core> node docs/screenshots/capture.mjs [shots...]
//
// Shots: consent, hero, injection, tools, approvals, audit, clients, eval, connect.
// HERO_MODEL / INJECTION_MODEL pick the playground model (default: the first free OpenRouter model offered,
// else the offline demo model). Every step is driven like a user would: sign in, pick a preset, click Approve.
import { createRequire } from 'module';

const require = createRequire(process.env.PUPPETEER_FROM ?? import.meta.url);
const puppeteer = require('puppeteer-core');
const ADMIN = process.env.ADMIN_URL ?? 'http://localhost:3000';
const out = process.env.OUT_DIR ?? new URL('.', import.meta.url).pathname;
const shots = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1.5 });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
page.on('console', (message) => {
  if (message.type() === 'error') console.log('page error:', message.text());
});

async function shoot(name, { fullPage = true, clip } = {}) {
  await sleep(400);
  await page.screenshot({ path: `${out}${name}.png`, fullPage, ...(clip && { clip, fullPage: false }) });
  console.log(`${name}.png`);
}

// Sign in through the gateway's OAuth page (authorization code + PKCE), as Adam (admin).
await page.goto(`${ADMIN}/`, { waitUntil: 'networkidle0' });
if (page.url().includes('/oauth/authorize')) {
  if (shots.includes('consent')) {
    await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 1.5 });
    await shoot('consent');
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1.5 });
  }
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[value="approve"]')]);
}

async function runPlayground({ preset, model, approve = true, maxWait = 300_000 }) {
  await page.goto(`${ADMIN}/playground`, { waitUntil: 'networkidle0' });
  await page.evaluate((title) => {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === title);
    button?.click();
  }, preset);
  if (model) {
    const selects = await page.$$('select');
    await selects[1]?.select(model);
  }
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Run')?.click());
  const started = Date.now();
  while (Date.now() - started < maxWait) {
    await sleep(1000);
    const state = await page.evaluate(() => ({
      running: [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Running…'),
      approve: [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Approve'),
    }));
    if (state.approve) {
      await sleep(1500);
      await page.evaluate((ok) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === (ok ? 'Approve' : 'Decline'))?.click(), approve);
    }
    if (!state.running && !state.approve) break;
  }
  await sleep(800);
}

for (const shot of shots) {
  if (shot === 'consent') continue;
  if (shot === 'hero') {
    await runPlayground({ preset: 'ACME tickets older than a week, noted on the deal', model: process.env.HERO_MODEL });
    await shoot('hero');
  } else if (shot === 'injection') {
    await runPlayground({ preset: 'Ticket with a planted exfiltration instruction', model: process.env.INJECTION_MODEL ?? 'fake-gullible' });
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => d.setAttribute('open', '')));
    await shoot('injection');
  } else if (['tools', 'approvals', 'audit', 'clients', 'eval', 'connect'].includes(shot)) {
    await page.goto(`${ADMIN}/${shot}`, { waitUntil: 'networkidle0' });
    await shoot(shot);
  } else if (shot === 'overview') {
    await page.goto(`${ADMIN}/`, { waitUntil: 'networkidle0' });
    await shoot('overview');
  }
}
await browser.close();
