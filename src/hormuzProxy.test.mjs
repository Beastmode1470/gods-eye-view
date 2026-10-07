import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHormuzMiddleware,
  hormuzProxy,
  resolveHormuzUrl,
} from '../tools/hormuz-proxy.mjs';

async function request(middleware, url, method = 'GET', extra = {}) {
  let body;
  let next = false;
  const headers = {};
  const res = {
    statusCode: 200,
    setHeader: (key, value) => {
      headers[key] = value;
    },
    end: (text) => {
      body = JSON.parse(text);
    },
  };
  await middleware(
    { url, method, headers: { host: '127.0.0.1:4173' }, ...extra },
    res,
    () => {
      next = true;
    },
  );
  return { status: res.statusCode, body, headers, next };
}

test('legacy CLI aliases retain AISStream identity with absent browser credentials', async () => {
  const middleware = createHormuzMiddleware(
    'http://127.0.0.1:8908',
    async (url) =>
      new Response(
        JSON.stringify(
          url.endsWith('/api/config')
            ? {
                recordingSource: 'aisstream',
                cesiumToken: null,
                googleMapsKey: null,
                center: null,
              }
            : {
                recordingSource: 'aisstream',
                poll: { data_stamp: '2026-10-02T19:30:00-05:00' },
                vessels: [
                  {
                    mmsi: '123456789',
                    lat: 26,
                    lon: 56,
                    type: 'Cargo',
                    heading: 90,
                    last_position_UTC: '2026-10-02T19:30:00-05:00',
                  },
                ],
              },
        ),
      ),
  );
  const config = await request(middleware, '/api/hormuz/config');
  assert.equal(config.status, 200);
  assert.equal(config.body.recordingSource, 'aisstream');
  assert.equal(config.body.center, null);
  assert.equal(config.body.cesiumToken, '');
  const frame = await request(middleware, '/api/vessels');
  assert.equal(frame.status, 200);
  assert.equal(frame.body.recordingSource, 'aisstream');
  assert.match(frame.body.source, /AISStream/);
  assert.equal(frame.body.rows[0].type, 'Cargo');
  assert.equal(frame.body.rows[0].heading, 90);
  assert.equal(frame.body.snapshotAt, Date.parse('2026-10-02T19:30:00-05:00'));
});

test('oversized global snapshots project bounded rows with explicit partial coverage', async () => {
  const middleware = createHormuzMiddleware(
    'http://127.0.0.1:8908',
    async () =>
      new Response(
        JSON.stringify({
          recordingSource: 'aisstream',
          poll: { poll_id: 1, data_stamp: '2026-10-02T12:00:00Z' },
          vessels: Array.from({ length: 12001 }, (_, i) => ({
            mmsi: String(i + 1),
            lat: 26,
            lon: 56,
          })),
        }),
      ),
  );
  for (const route of ['/api/vessels', '/api/hormuz/snapshot?poll_id=1']) {
    const response = await request(middleware, route);
    assert.equal(response.status, 200);
    assert.equal(response.body.rows.length, 12000);
    assert.equal(response.body.truncated, true);
    assert.equal(response.body.totalRows, 12001);
  }
});

test('only explicit loopback origins allowed, disabled mode has no middleware', () => {
  assert.equal(resolveHormuzUrl(''), null);
  for (const value of [
    'http://127.0.0.1:8808',
    'http://localhost:8808',
    'http://[::1]:8808',
  ])
    assert.ok(resolveHormuzUrl(value));
  for (const value of [
    'https://remote.example',
    'http://10.0.0.1:8808',
    'http://localhost@evil.example',
    'http://user:password@localhost',
    'http://localhost/api/live',
    'http://localhost/?url=evil',
  ]) {
    assert.throws(() => resolveHormuzUrl(value));
  }
  assert.throws(() => createHormuzMiddleware('https://remote.example'));
  let installed = false;
  hormuzProxy(null).configureServer({
    middlewares: {
      use: () => {
        installed = true;
      },
    },
  });
  assert.equal(installed, false);
  assert.throws(
    () =>
      hormuzProxy('http://127.0.0.1:8808').configResolved({
        server: { host: '0.0.0.0' },
        preview: { host: '127.0.0.1' },
      }),
    /loopback/,
  );
});

test('snapshot and selected trail routes adapt fixed local paths without forwarding credentials', async () => {
  const calls = [];
  const middleware = createHormuzMiddleware(
    'http://127.0.0.1:8808',
    async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify(
          url.includes('/track/')
            ? {
                mmsi: '123456789',
                points: [
                  { lat: 26, lon: 56, observed_at: '2026-10-02T12:00:00Z' },
                ],
              }
            : {
                poll: null,
                vessels: [{ mmsi: '123456789', lat: 26, lon: 56 }],
              },
        ),
      );
    },
  );
  const snapshot = await request(
    middleware,
    '/api/vessels?maxRows=1&url=https://evil.example',
  );
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.rows.length, 1);
  const track = await request(middleware, '/api/vessels/track?mmsi=123456789');
  assert.equal(track.body.samples.length, 1);
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'http://127.0.0.1:8808/api/live',
      'http://127.0.0.1:8808/api/track/123456789?hours=720',
    ],
  );
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(snapshot.headers['Cache-Control'], 'no-store');
});

test('reject invalid paths, writes, cross-origin and remote peers without touching the backend', async () => {
  const middleware = createHormuzMiddleware('http://127.0.0.1:8808', () => {
    throw new Error('must not fetch');
  });
  assert.equal((await request(middleware, '/api/vessels', 'POST')).status, 405);
  assert.equal(
    (await request(middleware, '/api/vessels/track?mmsi=../stats')).status,
    400,
  );
  assert.equal((await request(middleware, '/api/vessels/private')).status, 404);
  assert.equal(
    (
      await request(middleware, '/api/vessels', 'GET', {
        socket: { remoteAddress: '192.168.1.10' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(middleware, '/api/vessels', 'GET', {
        headers: { origin: 'http://evil.example', host: '127.0.0.1:4173' },
      })
    ).status,
    403,
  );
  assert.equal((await request(middleware, '/api/forecast')).next, true);
  assert.equal(
    (
      await request(middleware, '/api/vessels', 'GET', {
        headers: { host: '127.0.0.1:4173', 'x-forwarded-for': '192.0.2.2' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(middleware, '/api/vessels', 'GET', {
        headers: { host: '192.0.2.2:4173' },
      })
    ).status,
    403,
  );
});

test('AI and external context uploads blocked even when provider keys exist', async () => {
  const middleware = createHormuzMiddleware('http://127.0.0.1:8808', () => {
    throw new Error('must not fetch');
  });
  for (const url of [
    '/api/realtime/token',
    '/api/realtime/debug-log',
    '/api/openai/hud-summary',
  ]) {
    assert.equal((await request(middleware, url, 'POST')).status, 403, url);
  }
  assert.equal((await request(middleware, '/api/terrain/heights')).next, true);
  for (const url of [
    '/api/google/text-search',
    '/api/regional-brief',
    '/api/route',
    '/api/overpass',
  ])
    assert.equal(
      (await request(middleware, url)).next,
      true,
      'Public map/search providers remain available',
    );
  assert.equal(
    (
      await request(
        middleware,
        '/api/military-installations?south=26&west=56&north=27&east=57',
      )
    ).next,
    true,
    'Mapped OSM installations retain their original bounded proxy; recorded AIS is not forwarded',
  );
  const save = await request(middleware, '/api/setup/keys', 'POST');
  assert.equal(save.status, 403);
  assert.match(save.body.error, /existing backend map credentials/);
});

test('public viewer omits private forecast models and projects collection context', async () => {
  const stats = {
    collection: { polls: 12 },
    crossings_daily: [],
    prices: [],
    portwatch: [],
  };
  const calls = [];
  const middleware = createHormuzMiddleware(
    'http://127.0.0.1:8808',
    async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(stats));
    },
  );
  const result = await request(
    middleware,
    '/api/hormuz/forecast?target_month=2026-10',
  );
  assert.equal(result.status, 503);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.deepEqual((await request(middleware, '/api/hormuz/stats')).body, {
    collection: stats.collection,
    crossings_daily: [],
    portwatch: [],
    recordingSource: 'hormuz',
  });
  assert.deepEqual(calls, ['http://127.0.0.1:8808/api/stats']);
  assert.equal(
    (await request(middleware, '/api/hormuz/stats?target_month=2026-10'))
      .status,
    400,
  );
  assert.equal(
    (await request(middleware, '/api/hormuz/stats', 'POST')).status,
    405,
  );
  assert.equal(
    (
      await request(middleware, '/api/hormuz/stats', 'GET', {
        socket: { remoteAddress: '192.168.1.10' },
      })
    ).status,
    403,
  );
  assert.equal((await request(middleware, '/api/hormuz/private')).status, 404);
  assert.equal(calls.length, 1);
});

test('forecast unavailability never invokes an external model', async () => {
  const middleware = createHormuzMiddleware(
    'http://127.0.0.1:8808',
    async () =>
      new Response(
        JSON.stringify({ error: 'No EIA jet-fuel spot price available' }),
        { status: 503 },
      ),
  );
  const result = await request(middleware, '/api/hormuz/forecast');
  assert.equal(result.status, 503);
  assert.match(result.body.error, /No forecast model/);
});

test('map config projects only approved provider fields with local-only no-store access', async () => {
  const middleware = createHormuzMiddleware(
    'http://127.0.0.1:8808',
    async (url) => {
      assert.equal(url, 'http://127.0.0.1:8808/api/config');
      return new Response(
        JSON.stringify({
          cesiumToken: 'test-ion-placeholder',
          googleMapsKey: 'test-google-placeholder',
          center: {
            lon: 56.4,
            lat: 26.6,
            height: 240000,
            privateField: 'excluded',
          },
          ports: [
            {
              name: 'TEST PORT',
              lon: 56,
              lat: 26,
              country: 'TEST',
              unrelated: 'excluded',
            },
          ],
          unrelatedSecret: 'excluded',
          gate: { unrelated: true },
          energyCategories: ['unrelated'],
        }),
      );
    },
  );
  const result = await request(middleware, '/api/hormuz/config');
  assert.equal(result.status, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.deepEqual(Object.keys(result.body).sort(), [
    'center',
    'cesiumToken',
    'googleMapsKey',
    'ports',
    'recordingSource',
  ]);
  assert.deepEqual(Object.keys(result.body.center).sort(), [
    'height',
    'lat',
    'lon',
  ]);
  assert.equal(result.body.ports[0].unrelated, undefined);
  assert.equal(
    (await request(middleware, '/api/hormuz/config?url=evil')).status,
    400,
  );
  assert.equal(
    (
      await request(middleware, '/api/hormuz/config', 'GET', {
        socket: { remoteAddress: '192.168.1.10' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(middleware, '/api/hormuz/config', 'GET', {
        headers: { host: 'localhost:4173', origin: 'http://evil.example' },
      })
    ).status,
    403,
  );
});

test('full aggregate history and single-day recorded replay use fixed bounded backend routes', async () => {
  const calls = [];
  const middleware = createHormuzMiddleware(
    'http://127.0.0.1:8808',
    async (url) => {
      calls.push(url);
      return new Response(
        JSON.stringify(
          url.includes('/history')
            ? {
                portwatch: [],
                crossings_daily: [],
                recorded_ais: {},
                sources: {},
              }
            : {
                tracks: [
                  {
                    mmsi: '1607',
                    points: [{ t: '2026-09-29T12:00:00Z', lat: 26, lon: 56 }],
                  },
                ],
              },
        ),
      );
    },
  );
  const history = await request(
    middleware,
    '/api/hormuz/history?start=2019-01-01&end=2026-10-02',
  );
  assert.equal(history.status, 200);
  const replay = await request(middleware, '/api/hormuz/replay?day=2026-09-29');
  assert.equal(replay.body.recorded, true);
  assert.equal(replay.body.truncated, false);
  assert.deepEqual(calls, [
    'http://127.0.0.1:8808/api/history?start=2019-01-01&end=2026-10-02',
    'http://127.0.0.1:8808/api/replay?start=2026-09-29T00%3A00%3A00&end=2026-09-29T23%3A59%3A59.999&limit=20000',
  ]);
  for (const path of [
    '/api/hormuz/history?start=2026-02-30',
    '/api/hormuz/history?start=2026-10-02&end=2026-03-01',
    '/api/hormuz/replay?day=2026-02-30',
    '/api/hormuz/replay?day=2026-09-29&limit=1000000',
  ]) {
    assert.equal((await request(middleware, path)).status, 400);
  }
});

test('busy recorded days load a bounded poll manifest and one complete snapshot at a time', async () => {
  const calls = [];
  const middleware = createHormuzMiddleware(
    'http://127.0.0.1:8808',
    async (url) => {
      calls.push(url);
      return new Response(
        JSON.stringify(
          url.includes('/polls')
            ? {
                polls: [
                  {
                    poll_id: 42,
                    data_stamp: '2026-10-03T12:00:00Z',
                    fetched_at: '2026-10-03T12:01:00Z',
                    unrelated: 'excluded',
                  },
                ],
              }
            : {
                poll: { poll_id: 42, data_stamp: '2026-10-03T12:00:00Z' },
                vessels: Array.from({ length: 1250 }, (_, i) => ({
                  mmsi: String(i + 1),
                  lat: 26,
                  lon: 56,
                  observed_at: '2026-10-03T12:00:00Z',
                })),
              },
        ),
      );
    },
  );
  const manifest = await request(
    middleware,
    '/api/hormuz/polls?day=2026-10-03',
  );
  assert.equal(manifest.status, 200);
  assert.equal(manifest.body.polls[0].poll_id, 42);
  assert.equal(manifest.body.polls[0].unrelated, undefined);
  const snapshot = await request(middleware, '/api/hormuz/snapshot?poll_id=42');
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.rows.length, 1250);
  assert.equal(snapshot.body.recorded, true);
  assert.equal(snapshot.body.snapshotAt, Date.parse('2026-10-03T12:00:00Z'));
  assert.deepEqual(calls, [
    'http://127.0.0.1:8808/api/polls?day=2026-10-03&limit=5000',
    'http://127.0.0.1:8808/api/snapshot?poll_id=42',
  ]);
  for (const path of [
    '/api/hormuz/polls?day=2026-02-30',
    '/api/hormuz/polls?day=2026-10-03&limit=9999',
    '/api/hormuz/snapshot?poll_id=0',
    '/api/hormuz/snapshot?poll_id=../config',
    '/api/hormuz/snapshot?poll_id=42&url=evil',
  ]) {
    assert.equal((await request(middleware, path)).status, 400);
  }
  assert.equal(
    (await request(middleware, '/api/hormuz/polls?day=2026-10-03', 'POST'))
      .status,
    405,
  );
});

test('missing recorded snapshot preserves the backend 404 rather than fabricating an empty frame', async () => {
  const middleware = createHormuzMiddleware(
    'http://127.0.0.1:8808',
    async () =>
      new Response(JSON.stringify({ detail: 'Recorded poll not found' }), {
        status: 404,
      }),
  );
  const result = await request(middleware, '/api/hormuz/snapshot?poll_id=42');
  assert.equal(result.status, 404);
  assert.match(result.body.detail, /not found/);
});

test('history replay cap is explicit and historical tracks exclude later observations', async () => {
  let route;
  const middleware = createHormuzMiddleware(
    'http://127.0.0.1:8808',
    async (url) => {
      route = url;
      return new Response(
        JSON.stringify(
          url.includes('/replay')
            ? {
                tracks: [
                  {
                    mmsi: '1607',
                    points: Array.from({ length: 20000 }, () => ({
                      lat: 26,
                      lon: 56,
                    })),
                  },
                ],
              }
            : {
                mmsi: '1607',
                points: [
                  { observed_at: '2026-09-29T12:00:00Z', lat: 26, lon: 56 },
                  { observed_at: '2026-10-02T12:00:00Z', lat: 27, lon: 57 },
                ],
              },
        ),
      );
    },
  );
  assert.equal(
    (await request(middleware, '/api/hormuz/replay?day=2026-09-29')).body
      .truncated,
    true,
  );
  const track = await request(
    middleware,
    '/api/vessels/track?mmsi=1607&before=2026-09-29T12%3A00%3A00Z',
  );
  assert.equal(track.body.samples.length, 1);
  assert.equal(route, 'http://127.0.0.1:8808/api/track/1607?hours=8760');
});

test('upstream errors and malformed/oversized responses are failures, never public-source fallback', async () => {
  for (const response of [
    new Response('failure', { status: 503 }),
    new Response('{}'),
    new Response('not json'),
    new Response('x', { headers: { 'content-length': '9000000' } }),
  ]) {
    const middleware = createHormuzMiddleware(
      'http://127.0.0.1:8808',
      async () => response,
    );
    const result = await request(middleware, '/api/vessels');
    assert.equal(result.status, 502);
    assert.deepEqual(result.body.rows, []);
    assert.match(result.body.error, /unavailable or invalid/);
  }
});

test('external read-only viewer supports normalized CLI routes and worldwide AISStream metadata', async () => {
  const calls = [];
  const observed = '2026-10-03T12:00:00Z';
  const middleware = createHormuzMiddleware(
    'http://127.0.0.1:8808',
    async (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (!path.startsWith('/api/hormuz/') && !path.startsWith('/api/vessels'))
        return new Response('{}', { status: 404 });
      let payload;
      if (path.endsWith('/config'))
        payload = {
          cesiumToken: null,
          googleMapsKey: null,
          center: null,
          ports: [],
          recordingSource: 'aisstream',
          privateCredential: 'excluded',
        };
      else if (path.endsWith('/track'))
        payload = {
          mmsi: '123456789',
          recorded: true,
          source: 'AISStream local recorded snapshots',
          samples: [
            { lat: 48, lon: -123, epochSec: Date.parse(observed) / 1000 },
            { lat: 49, lon: -124, epochSec: Date.parse(observed) / 1000 + 1 },
          ],
        };
      else if (path.endsWith('/history'))
        payload = {
          portwatch: [],
          crossings_daily: [],
          recorded_ais: {
            first_observed_at: observed,
            last_observed_at: observed,
          },
          sources: {},
          recordingSource: 'aisstream',
        };
      else if (path.endsWith('/polls'))
        payload = {
          polls: [{ poll_id: 42, data_stamp: observed }],
          recordingSource: 'aisstream',
        };
      else
        payload = {
          rows: [
            {
              mmsi: '123456789',
              lat: 48,
              lon: -123,
              type: 'Cargo',
              last_position_UTC: observed,
              recorded: true,
            },
          ],
          recorded: true,
          source: 'AISStream local recorded snapshots',
          snapshotAt: Date.parse(observed),
          collectedAt: Date.parse(observed) + 1000,
        };
      return new Response(JSON.stringify(payload));
    },
  );
  const config = await request(middleware, '/api/hormuz/config');
  assert.equal(config.body.recordingSource, 'aisstream');
  assert.equal(config.body.center, null);
  assert.equal(config.body.googleMapsKey, '');
  assert.equal(config.body.privateCredential, undefined);
  assert.deepEqual(calls, ['/api/config', '/api/hormuz/config']);
  const snapshot = await request(middleware, '/api/hormuz/snapshot?poll_id=42');
  assert.equal(snapshot.body.rows[0].lat, 48);
  assert.equal(snapshot.body.source, 'AISStream local recorded snapshots');
  assert.equal(snapshot.body.snapshotAt, Date.parse(observed));
  assert.equal(snapshot.body.collectedAt, Date.parse(observed) + 1000);
  const latest = await request(middleware, '/api/vessels?maxRows=100');
  assert.equal(latest.body.recordingSource, 'aisstream');
  const history = await request(
    middleware,
    '/api/hormuz/history?start=2026-10-01',
  );
  assert.equal(history.body.recordingSource, 'aisstream');
  const manifest = await request(
    middleware,
    '/api/hormuz/polls?day=2026-10-03',
  );
  assert.equal(manifest.body.polls[0].poll_id, 42);
  const track = await request(
    middleware,
    '/api/vessels/track?mmsi=123456789&before=' + observed,
  );
  assert.equal(track.body.samples.length, 1);
  assert.equal(track.body.source, 'AISStream local recorded snapshots');
  assert.ok(
    calls
      .slice(2)
      .every(
        (path) =>
          path.startsWith('/api/hormuz/') || path.startsWith('/api/vessels'),
      ),
  );
});
