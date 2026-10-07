import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { createBrowserViteConfig } from '../build/vite.js';

// Real standalone app, deterministic public fixtures, no archive/keys/providers.
// Run: node tools/qa-recorded-replay.mjs
const root = fileURLToPath(new URL('../', import.meta.url));
const times = [
  '2026-10-01T01:00:00Z',
  '2026-10-01T02:00:00Z',
  '2026-10-03T01:00:00Z',
  '2026-10-03T02:00:00Z',
];
const frames = times.map((time, index) => ({
  rows: [
    {
      mmsi: '123456789',
      name: 'PUBLIC QA FIXTURE',
      type: 'Cargo',
      lat: 26 + index * 0.001,
      lon: 56 + index * 0.001,
      recorded: true,
      last_position_UTC: time,
      last_position_epoch: Date.parse(time) / 1000,
    },
  ],
  source: 'AISStream local recorded snapshots',
  recordingSource: 'aisstream',
  recorded: true,
  status: 'recorded',
  snapshotAt: Date.parse(time),
  collectedAt: Date.parse(time) + 1000,
}));
let latestRequests = 0;
const replayed = [];
const config = createBrowserViteConfig({
  host: '127.0.0.1',
  port: 4198,
  googleApiKey: '',
  cesiumToken: '',
  plugins: [
    {
      name: 'public-recording-fixture',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url, 'http://localhost');
          if (!url.pathname.startsWith('/api/')) return next();
          let payload;
          if (url.pathname === '/api/hormuz/config')
            payload = {
              cesiumToken: '',
              googleMapsKey: '',
              center: null,
              ports: [],
              recordingSource: 'aisstream',
            };
          else if (url.pathname === '/api/vessels') {
            latestRequests++;
            payload = frames.at(-1);
          } else if (url.pathname === '/api/vessels/track')
            payload = {
              mmsi: '123456789',
              recorded: true,
              samples: [],
            };
          else if (url.pathname === '/api/hormuz/history')
            payload = {
              portwatch: [],
              crossings_daily: [],
              sources: {},
              recordingSource: 'aisstream',
              recorded_ais: {
                first_observed_at: times[0],
                last_observed_at: times.at(-1),
              },
            };
          else if (url.pathname === '/api/hormuz/polls')
            payload = {
              polls: times.flatMap((time, index) =>
                time.slice(0, 10) === url.searchParams.get('day')
                  ? [{ poll_id: index + 1, data_stamp: time, fetched_at: time }]
                  : [],
              ),
            };
          else if (url.pathname === '/api/hormuz/snapshot') {
            const id = Number(url.searchParams.get('poll_id'));
            replayed.push(id);
            payload = frames[id - 1];
          } else {
            res.statusCode = 503;
            payload = {
              error:
                'Provider intentionally unavailable in public replay QA fixture',
            };
          }
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(payload));
        });
      },
    },
  ],
});
config.define['import.meta.env.HORMUZ_RECORDED_MODE'] = 'true';
config.define['import.meta.env.AIS_RECORDING_SOURCE'] =
  JSON.stringify('aisstream');
const server = await createServer({
  ...config,
  root,
  configFile: false,
  envFile: false,
  server: { ...config.server, strictPort: false },
});
let browser;
let page;
try {
  await server.listen();
  const systemChrome =
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  browser = await puppeteer.launch({
    ...(existsSync(systemChrome) ? { executablePath: systemChrome } : {}),
    headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-angle=swiftshader'],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0], {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 90000,
  });
  assert.match(await page.title(), /^AISSTREAM RECORDING/);
  await page.evaluate(async () => {
    await window.__godsEyeView.dataManager.setEnabled(
      'ais-live-vessels',
      true,
      { origin: 'user' },
    );
    document.getElementById('hormuz-history').open = true;
  });
  await page.waitForFunction(
    () => document.getElementById('hormuz-history-day').max === '2026-10-03',
  );
  await page.select('#hormuz-history-source', 'recorded');
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('ais-live-vessels')
        .module.getStats().historyMode,
  );
  const latestAtReplay = latestRequests;
  await page.$eval('#hormuz-history-day', (input) => {
    input.value = '2026-10-01';
    input.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('ais-live-vessels')
        .module.getStats().snapshotAt === Date.parse('2026-10-01T01:00:00Z'),
  );
  assert.equal(
    await page.$eval('#hormuz-source-status a', (link) => link.href),
    'https://aisstream.io/',
  );
  await page.$eval('#hormuz-history-scrub', (input) => {
    input.value = '1';
    input.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('ais-live-vessels')
        .module.getStats().snapshotAt === Date.parse('2026-10-01T02:00:00Z'),
  );
  await page.click('#hormuz-history-refresh');
  await page.waitForFunction(
    () =>
      document.getElementById('hormuz-history-scrub').value === '1' &&
      document
        .getElementById('hormuz-history-readout')
        .textContent.includes('snapshot 2/2'),
  );
  assert.equal(
    await page.$eval('#hormuz-history-day', (input) => input.value),
    '2026-10-01',
  );
  await page.select('#hormuz-history-speed', '30');
  await page.click('#hormuz-history-play');
  await page.waitForFunction(
    () =>
      document.getElementById('hormuz-history-day').value === '2026-10-03' &&
      document.getElementById('hormuz-history-play').textContent === 'Play',
    { timeout: 15000 },
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('ais-live-vessels')
          .module.getStats().snapshotAt,
    ),
    Date.parse(times.at(-1)),
  );
  assert.ok(
    replayed.includes(3) && replayed.includes(4),
    'Every later observed frame must be fetched',
  );
  await page.evaluate(async () => {
    const { dataManager, viewer } = window.__godsEyeView;
    await dataManager.layers.get('ais-live-vessels').module.update(viewer);
    await dataManager.setEnabled('ais-live-vessels', false, { origin: 'user' });
    const input = document.getElementById('hormuz-history-day');
    input.value = '2026-10-01';
    input.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() =>
    document
      .getElementById('hormuz-history-readout')
      .textContent.includes('layer off'),
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers.get('ais-live-vessels').enabled,
    ),
    false,
  );
  assert.equal(
    latestRequests,
    latestAtReplay,
    'Replay/update/date seek must not fetch Latest',
  );
  await page.$eval('#hormuz-history-day', (input) => {
    input.value = '2026-10-02';
    input.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() =>
    document
      .getElementById('hormuz-history-readout')
      .textContent.includes('No individual recorded positions'),
  );
  await page.click('#hormuz-history-latest');
  await page.evaluate(async () => {
    await window.__godsEyeView.dataManager.setEnabled(
      'ais-live-vessels',
      true,
      { origin: 'user' },
    );
  });
  await page.waitForFunction(() => {
    const stats = window.__godsEyeView.dataManager.layers
      .get('ais-live-vessels')
      .module.getStats();
    return !stats.historyMode && stats.count === 1;
  });
  assert.ok(
    latestRequests > latestAtReplay,
    'Latest resumes snapshot fetching',
  );
  assert.deepEqual(
    errors,
    [],
    'The real app must not throw browser exceptions',
  );
  console.log(
    'PASS real browser: source label, exact UTC day/frame seek, refresh, chronological gaps, polling pause/resume, layer toggles',
  );
} catch (error) {
  console.error(
    await page
      ?.evaluate(() => ({
        readout: document.getElementById('hormuz-history-readout')?.textContent,
        stats: window.__godsEyeView?.dataManager.layers
          .get('ais-live-vessels')
          ?.module.getStats(),
        enabled:
          window.__godsEyeView?.dataManager.layers.get('ais-live-vessels')
            ?.enabled,
        loader: document.querySelector('.loader-status')?.textContent,
      }))
      .catch(() => null),
  );
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
