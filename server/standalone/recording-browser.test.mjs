import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { createServer as createViteServer } from 'vite';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const EDGE_PATH =
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME_PATH = await puppeteer.executablePath();
const BROWSER_PATH = existsSync(CHROME_PATH)
  ? CHROME_PATH
  : existsSync(EDGE_PATH)
    ? EDGE_PATH
    : null;

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
<script type="module">
  import { initHormuzHistory } from '/src/hormuzHistory.js';

  window.runRecordedReplayFixture = async () => {
    const history = {
      portwatch: [],
      crossings_daily: [],
      sources: {},
      recordingSource: 'aisstream',
      recorded_ais: {
        first_observed_at: '2026-10-01T23:55:00Z',
        last_observed_at: '2026-10-03T00:05:00Z',
      },
    };
    const polls = {
      '2026-10-01': [
        { poll_id: 1, data_stamp: '2026-10-01T23:55:00Z' },
        { poll_id: 2, data_stamp: '2026-10-01T23:59:00Z' },
      ],
      '2026-10-02': [],
      '2026-10-03': [
        { poll_id: 3, data_stamp: '2026-10-03T00:01:00Z' },
        { poll_id: 4, data_stamp: '2026-10-03T00:05:00Z' },
      ],
    };
    const calls = [];
    const shownPollIds = [];
    const illustrations = [];
    let layerEnabled = true;
    let latestResumes = 0;
    const layer = {
      prepareRecordedHistory() {},
      showRecordedFrame(frame) {
        shownPollIds.push(frame.pollId);
      },
      finishRecordedMotion() {},
      async resumeRecordedLatest() {
        latestResumes += 1;
      },
      getStats() {
        return { historyMode: true, error: null };
      },
    };
    const manager = {
      layers: { get() { return { enabled: layerEnabled }; } },
      setEnabled() { throw new Error('Replay must preserve the layer toggle'); },
    };
    const dispose = initHormuzHistory(
      manager,
      layer,
      {},
      'aisstream',
      {
        enabled: true,
        fetchImpl: async (url) => {
          calls.push(String(url));
          const parsed = new URL(url, location.href);
          let payload;
          if (parsed.pathname.endsWith('/history')) {
            payload = history;
          } else if (parsed.pathname.endsWith('/polls')) {
            payload = { polls: polls[parsed.searchParams.get('day')] || [] };
          } else if (parsed.pathname.endsWith('/snapshot')) {
            const pollId = Number(parsed.searchParams.get('poll_id'));
            const poll = Object.values(polls).flat().find((row) => row.poll_id === pollId);
            payload = {
              recorded: true,
              source: 'AISStream local recorded snapshots',
              rows: [],
              pollId,
              snapshotAt: Date.parse(poll.data_stamp),
            };
          } else {
            throw new Error(\`Unexpected browser request: \${parsed.pathname}\`);
          }
          return new Response(JSON.stringify(payload), {
            headers: { 'Content-Type': 'application/json' },
          });
        },
        createIllustration() {
          return {
            show(day, observation) {
              illustrations.push({ day, observation });
            },
            clear() {},
            destroy() {},
          };
        },
      },
    );

    const panel = document.querySelector('#hormuz-history');
    const find = (id) => panel.querySelector(\`#hormuz-history-\${id}\`);
    const wait = () => new Promise((resolve) => setTimeout(resolve, 40));
    const change = (input, value, event = 'change') => {
      input.value = value;
      input.dispatchEvent(new Event(event, { bubbles: true }));
    };

    panel.open = true;
    panel.dispatchEvent(new Event('toggle'));
    await wait();
    change(find('source'), 'recorded');
    await wait();
    change(find('day'), '2026-10-01');
    await wait();
    const firstDayPoll = shownPollIds.at(-1);
    change(find('scrub'), '1', 'input');
    await wait();
    const soughtPoll = shownPollIds.at(-1);

    change(find('speed'), '30');
    find('play').click();
    await new Promise((resolve) => setTimeout(resolve, 950));
    find('play').click();
    const crossedUtcGap = find('day').value === '2026-10-03';
    const playedPolls = shownPollIds.slice();

    layerEnabled = false;
    change(find('day'), '2026-10-01');
    await wait();
    const offLayerReadout = find('readout').textContent;
    const afterOffLayer = shownPollIds.length;
    layerEnabled = true;
    find('latest').click();
    await wait();
    const final = {
      sourceLabel: find('disclosure').textContent,
      firstDayPoll,
      soughtPoll,
      crossedUtcGap,
      selectedDayAfterPlayback: find('day').value,
      playedPolls,
      offLayerReadout,
      layerDidNotRenderWhileDisabled: shownPollIds.length === afterOffLayer,
      latestResumes,
      calls,
      liveFetches: calls.filter((url) => new URL(url, location.href).pathname === '/api/vessels'),
      illustrations,
    };
    dispose?.();
    return final;
  };
</script>
</body></html>`;

test(
  'real Chromium replays actual recorded frames across UTC days without live fetches',
  {
    skip: BROWSER_PATH
      ? false
      : 'No local Edge or Puppeteer Chromium executable is available',
  },
  async () => {
    const vite = await createViteServer({
      configFile: false,
      root: ROOT,
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
    });
    const server = createServer((req, res) => {
      if (req.url === '/__recorded-replay-fixture__') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(FIXTURE_HTML);
        return;
      }
      vite.middlewares(req, res, () => {
        res.statusCode = 404;
        res.end('Not found');
      });
    });
    let browser;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      browser = await puppeteer.launch({
        executablePath: BROWSER_PATH,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${server.address().port}/__recorded-replay-fixture__`,
        { waitUntil: 'networkidle0', timeout: 30_000 },
      );
      await page.waitForFunction(
        () => typeof window.runRecordedReplayFixture === 'function',
        { timeout: 30_000 },
      );
      const result = await page.evaluate(() =>
        window.runRecordedReplayFixture(),
      );
      assert.equal(result.firstDayPoll, 1, JSON.stringify(result));
      assert.equal(
        result.soughtPoll,
        2,
        'Date/frame seeking must select an exact poll',
      );
      assert.equal(
        result.crossedUtcGap,
        true,
        'Playback crosses midnight and skips the day with no observations',
      );
      assert.ok(result.playedPolls.includes(3));
      assert.ok(result.playedPolls.includes(4));
      assert.match(result.offLayerReadout, /layer off/);
      assert.equal(result.layerDidNotRenderWhileDisabled, true);
      assert.equal(result.latestResumes, 1);
      assert.deepEqual(
        result.liveFetches,
        [],
        'Historical playback must not call the live vessel endpoint',
      );
      assert.deepEqual(pageErrors, []);
    } finally {
      if (browser) await browser.close();
      server.closeAllConnections?.();
      server.close();
      await vite.close();
    }
  },
);
