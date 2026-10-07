import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createRecordingController } from './recording.js';
import { createRecordingStore } from './recording-store.js';
import { parseCollectorArgs } from '../../../scripts/collect-ais.mjs';

const tempRoots = new Set();

function tempDb(name = 'recording.sqlite') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gev-recording-test-'));
  tempRoots.add(root);
  return path.join(root, name);
}

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function sample(overrides = {}) {
  return {
    mmsi: '123456789',
    lat: 26.4,
    lon: 56.2,
    observed_at: '2026-10-07T12:00:00Z',
    name: 'VESSEL',
    ...overrides,
  };
}

function request(
  controller,
  url,
  {
    method = 'GET',
    remoteAddress = '127.0.0.1',
    host = '127.0.0.1:8808',
    headers = {},
  } = {},
) {
  let text;
  const responseHeaders = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(name, value) {
      responseHeaders[name] = value;
    },
    end(value) {
      text = value;
      this.headersSent = true;
    },
  };
  const req = {
    url,
    method,
    headers: { host, ...headers },
    socket: { remoteAddress },
  };
  return Promise.resolve(controller.handleRequest(req, res, () => {})).then(
    () => ({
      status: res.statusCode,
      headers: responseHeaders,
      body: text ? JSON.parse(text) : null,
    }),
  );
}

test('collector CLI validates source-specific polling constraints and never accepts unknown switches', () => {
  const once = parseCollectorArgs(['--source', 'hormuz', '--once'], {});
  assert.equal(once.source, 'hormuz');
  assert.equal(once.once, true);
  assert.equal(once.interval, '900');
  assert.equal(once.port, 8908);
  assert.equal(
    parseCollectorArgs(['--source', 'hormuz', '--port', '8910'], {}).port,
    8910,
  );
  assert.equal(
    parseCollectorArgs(['--source', 'hormuz'], {
      AIS_RECORDING_INTERVAL_SECONDS: '',
    }).interval,
    '900',
  );
  assert.equal(
    parseCollectorArgs(['--source', 'aisstream', '--interval', '10'], {
      AISSTREAM_API_KEY: 'fixture-key',
    })
      .interval,
    '10',
  );
  assert.equal(
    parseCollectorArgs(['--source', 'aisstream'], {
      AISSTREAM_API_KEY: 'fixture-key',
      AIS_RECORDING_INTERVAL_SECONDS: '',
    }).interval,
    '60',
  );
  assert.throws(
    () => parseCollectorArgs(['--source', 'aisstream'], {}),
    /requires AISSTREAM_API_KEY/,
  );
  assert.throws(
    () =>
      parseCollectorArgs(['--source', 'aisstream'], {
        AISSTREAM_API_KEY: '   ',
      }),
    /requires AISSTREAM_API_KEY/,
  );
  for (const args of [
    [],
    ['--source', 'unknown'],
    ['--source', 'hormuz', '--interval', '599'],
    ['--source', 'aisstream', '--interval', '9'],
    ['--source', 'aisstream', '--once'],
    ['--source', 'hormuz', '--once', '--once'],
    ['--source', 'hormuz', '--unrecognized'],
  ]) {
    assert.throws(
      () =>
        parseCollectorArgs(args, {
          AISSTREAM_API_KEY: 'fixture-key',
        }),
      undefined,
      args.join(' '),
    );
  }
});

test('store persists immutable observations, deduplicates source batch stamps, and enforces one source', () => {
  const dbPath = tempDb();
  const store = createRecordingStore({ dbPath, source: 'hormuz' });
  const first = store.recordPoll({
    dataStamp: '2026-10-07T12:00:00Z',
    fetchedAt: '2026-10-07T12:01:00Z',
    sourceLastPoll: '2026-10-07T11:59:00Z',
    vessels: [
      sample(),
      sample({ mmsi: '987654321', observed_at: '2026-10-07T11:59:00Z' }),
    ],
    crossings: [{ day: '2026-10-07', direction: 'inbound', count: 7 }],
  });
  assert.equal(first.positions, 2);
  const duplicate = store.recordPoll({
    dataStamp: '2026-10-07T12:00:00Z',
    fetchedAt: '2026-10-07T12:02:00Z',
    vessels: [sample({ lat: 0 })],
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.snapshot(first.poll_id).vessels[0].lat, 26.4);
  assert.equal(store.pollsForDay('2026-10-07').length, 1);
  assert.deepEqual(store.track('123456789', '2026-10-07T12:00:00Z'), [
    { lat: 26.4, lon: 56.2, epochSec: 1791374400 },
  ]);
  store.close();

  const reopened = createRecordingStore({ dbPath, source: 'hormuz' });
  assert.equal(reopened.stats().collection.positions, 2);
  reopened.close();
  assert.throws(
    () => createRecordingStore({ dbPath, source: 'aisstream' }),
    /already belongs/,
  );
});

test('store rejects a concurrent writer and releases the lock on close', () => {
  const dbPath = tempDb();
  const writer = createRecordingStore({ dbPath, source: 'hormuz' });
  assert.throws(
    () => createRecordingStore({ dbPath, source: 'hormuz' }),
    (error) =>
      error.code === 'ERR_RECORDING_WRITER_LOCKED' &&
      error.message.includes('Stop the other collector/viewer first'),
  );
  writer.close();
  const nextWriter = createRecordingStore({ dbPath, source: 'hormuz' });
  nextWriter.close();
});

test('controller can close its store without stopping the shared AIS source', async () => {
  const dbPath = tempDb();
  let stops = 0;
  const controller = createRecordingController({
    source: 'aisstream',
    dbPath,
    env: { AIS_RECORDING_INTERVAL_SECONDS: '10' },
    stopAisSource: false,
    aisSource: {
      start() {},
      read() {
        return { status: 'missing-key', rows: [] };
      },
      stop() {
        stops++;
      },
    },
  });
  controller.start();
  await controller.stop();
  assert.equal(stops, 0);
});

test('store rejects fake/invalid observations, allows recorded failures, and recovers a failed source batch', () => {
  const store = createRecordingStore({ dbPath: tempDb(), source: 'hormuz' });
  const failed = store.recordPoll({
    dataStamp: '2026-10-07T12:00:00Z',
    fetchedAt: '2026-10-07T12:01:00Z',
    error: 'upstream unavailable',
    crossings: [{ day: '2026-10-07', direction: 'inbound', count: 3 }],
  });
  assert.equal(store.snapshot(failed.poll_id), null);
  assert.equal(
    store.history({ start: '2026-10-07', end: '2026-10-07' }).crossings_daily[0]
      .count,
    3,
  );
  const recovered = store.recordPoll({
    dataStamp: '2026-10-07T12:00:00Z',
    fetchedAt: '2026-10-07T12:02:00Z',
    vessels: [
      sample(),
      sample({ mmsi: '222222222', observed_at: 'not a timestamp' }),
      sample({ mmsi: '333333333', lat: 91 }),
    ],
  });
  assert.equal(recovered.poll_id, failed.poll_id);
  assert.equal(recovered.positions, 1);
  assert.equal(store.stats().collection.failed_polls, 0);
  assert.equal(store.snapshot(recovered.poll_id).vessels.length, 1);
  store.close();
});

test('store rolls back an entire frame on a write error and bounds poll manifests', () => {
  const dbPath = tempDb();
  const store = createRecordingStore({ dbPath, source: 'hormuz' });
  const setup = new DatabaseSync(dbPath);
  setup.exec(`
    CREATE TRIGGER reject_test_crossing BEFORE INSERT ON crossings_daily
    BEGIN SELECT RAISE(ABORT, 'test rollback'); END;
  `);
  setup.close();
  assert.throws(
    () =>
      store.recordPoll({
        dataStamp: '2026-10-07T12:00:00Z',
        fetchedAt: '2026-10-07T12:01:00Z',
        vessels: [sample()],
        crossings: [{ day: '2026-10-07', direction: 'inbound', count: 1 }],
      }),
    /test rollback/,
  );
  assert.equal(store.latestSnapshot(), null);
  assert.equal(store.stats().collection.polls, 0);

  for (const minute of ['00', '01']) {
    store.recordPoll({
      dataStamp: `2026-10-07T12:${minute}:00Z`,
      fetchedAt: `2026-10-07T12:${minute}:01Z`,
      vessels: [],
    });
  }
  assert.throws(() => store.pollsForDay('2026-10-07', 1), /exceeds 1 rows/);
  store.close();

  const unrelatedPath = tempDb('unrelated.sqlite');
  const unrelated = new DatabaseSync(unrelatedPath);
  unrelated.exec(
    "CREATE TABLE user_data (value TEXT); INSERT INTO user_data VALUES ('untouched');",
  );
  unrelated.close();
  assert.throws(
    () => createRecordingStore({ dbPath: unrelatedPath, source: 'hormuz' }),
    /Refusing to modify an existing SQLite database/,
  );
  const verifyUnrelated = new DatabaseSync(unrelatedPath, { readOnly: true });
  assert.equal(
    verifyUnrelated.prepare('SELECT value FROM user_data').get().value,
    'untouched',
  );
  verifyUnrelated.close();
});

test('AISStream poll manifests exceed the old 5000-row cap and reject overflow explicitly', () => {
  const dbPath = tempDb();
  createRecordingStore({ dbPath, source: 'aisstream' }).close();

  function insertPolls(start, count) {
    const db = new DatabaseSync(dbPath);
    const insert = db.prepare(
      'INSERT INTO polls(data_stamp,fetched_at,status) VALUES(?,? ,?)',
    );
    db.exec('BEGIN');
    try {
      for (let index = start; index < start + count; index += 1) {
        const stamp = new Date(
          Date.parse('2026-10-07T00:00:00.000Z') + index,
        ).toISOString();
        insert.run(stamp, stamp, 'success');
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      db.close();
    }
  }

  insertPolls(0, 5_001);
  const store = createRecordingStore({ dbPath, source: 'aisstream' });
  assert.equal(store.pollsForDay('2026-10-07').length, 5_001);
  store.close();

  insertPolls(5_001, 5_000);
  const fullStore = createRecordingStore({ dbPath, source: 'aisstream' });
  assert.throws(
    () => fullStore.pollsForDay('2026-10-07'),
    /Poll manifest exceeds 10000 rows/,
  );
  fullStore.close();
});

test('Hormuz collector uses fixed non-redirecting source URLs and the ships batch timestamp', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const pathname = new URL(url).pathname;
    const payload = pathname.endsWith('/summary')
      ? { last_poll: '2026-10-07T12:10:00Z' }
      : pathname.endsWith('/ships')
        ? {
            data_stamp: '2026-10-07T12:09:00Z',
            vessels: [
              sample(),
              sample({ mmsi: '222222222', observed_at: null }),
            ],
          }
        : [{ day: '2026-10-07', direction: 'inbound', count: 8 }];
    return new Response(JSON.stringify(payload));
  };
  const controller = createRecordingController({
    source: 'hormuz',
    dbPath: tempDb(),
    env: {
      AIS_RECORDING_INTERVAL_SECONDS: '600',
      AISSTREAM_API_KEY: 'never-expose-this',
      GOOGLE_MAPS_SERVER_API_KEY: 'server-map-secret',
    },
    fetchImpl,
  });
  try {
    await controller.recordPoll();
    assert.equal(controller.health.status, 'recorded');
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((call) => call.url),
      [
        'https://hormuz.data-tracking.net/api/summary',
        'https://hormuz.data-tracking.net/api/ships',
        'https://hormuz.data-tracking.net/api/crossings/daily',
      ],
    );
    assert.ok(calls.every((call) => call.options.redirect === 'error'));
    const frame = controller.store.latestSnapshot();
    assert.equal(frame.poll.data_stamp, '2026-10-07T12:09:00.000Z');
    assert.equal(frame.vessels.length, 1);
    assert.equal(
      controller.store.history({ start: '2026-10-07', end: '2026-10-07' })
        .crossings_daily[0].count,
      8,
    );

    const config = await request(controller, '/api/hormuz/config');
    assert.deepEqual(Object.keys(config.body).sort(), [
      'center',
      'cesiumToken',
      'googleMapsKey',
      'ports',
      'recordingName',
      'recordingSource',
    ]);
    assert.equal(
      JSON.stringify(config.body).includes('never-expose-this'),
      false,
    );
    assert.equal(
      JSON.stringify(config.body).includes('server-map-secret'),
      false,
    );
    assert.equal(config.body.googleMapsKey, '');
  } finally {
    await controller.stop();
  }
});

test('recorded routes are bounded, same-site loopback reads and preserve failures', async () => {
  let fail = false;
  const fetchImpl = async (url) => {
    if (fail) return new Response('unavailable', { status: 503 });
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/summary'))
      return new Response(
        JSON.stringify({ last_poll: '2026-10-07T12:00:00Z' }),
      );
    if (pathname.endsWith('/ships'))
      return new Response(
        JSON.stringify({
          data_stamp: '2026-10-07T12:00:00Z',
          vessels: [sample()],
        }),
      );
    return new Response(JSON.stringify([]));
  };
  const controller = createRecordingController({
    source: 'hormuz',
    dbPath: tempDb(),
    env: { AIS_RECORDING_INTERVAL_SECONDS: '600' },
    fetchImpl,
  });
  try {
    await controller.recordPoll();
    const latest = await request(controller, '/api/vessels');
    assert.equal(latest.status, 200);
    assert.equal(latest.body.rows[0].recorded, true);
    assert.equal(latest.body.rows[0].source, 'Hormuz local recorded snapshots');
    assert.equal(latest.body.snapshotAt, Date.parse('2026-10-07T12:00:00Z'));
    const polls = await request(controller, '/api/hormuz/polls?day=2026-10-07');
    assert.equal(polls.body.polls.length, 1);
    const frame = await request(
      controller,
      `/api/hormuz/snapshot?poll_id=${polls.body.polls[0].poll_id}`,
    );
    assert.deepEqual(frame.body.rows, latest.body.rows);
    const legacyLive = await request(controller, '/api/live');
    assert.ok(
      Array.isArray(legacyLive.body.vessels),
      JSON.stringify(legacyLive.body),
    );
    assert.equal(
      legacyLive.body.vessels[0].observed_at,
      '2026-10-07T12:00:00.000Z',
    );
    assert.equal(legacyLive.body.poll.data_stamp, '2026-10-07T12:00:00.000Z');
    const legacySnapshot = await request(
      controller,
      `/api/snapshot?poll_id=${polls.body.polls[0].poll_id}`,
    );
    assert.equal(legacySnapshot.body.vessels[0].mmsi, '123456789');
    const legacyTrack = await request(
      controller,
      '/api/track/123456789?hours=8760',
    );
    assert.ok(
      Array.isArray(legacyTrack.body.points),
      JSON.stringify(legacyTrack.body),
    );
    assert.ok(Array.isArray(legacyTrack.body.points));
    assert.equal(
      (await request(controller, '/api/stats')).body.collection.positions,
      1,
    );
    const track = await request(
      controller,
      '/api/vessels/track?mmsi=123456789&before=2026-10-07T12%3A00%3A00Z',
    );
    assert.deepEqual(track.body.samples, [
      { lat: 26.4, lon: 56.2, epochSec: 1791374400 },
    ]);

    for (const [url, expected] of [
      ['/api/hormuz/polls?day=2026-02-30', 400],
      ['/api/hormuz/snapshot?poll_id=0', 400],
      ['/api/vessels/track?mmsi=../../etc', 400],
      ['/api/track/not-a-mmsi?hours=8760', 400],
      ['/api/hormuz/history?start=2026-10-08&end=2026-10-07', 400],
      ['/api/hormuz/history?start=2000-01-01&end=2026-10-07', 400],
    ])
      assert.equal((await request(controller, url)).status, expected, url);
    assert.equal(
      (await request(controller, '/api/hormuz/forecast')).status,
      503,
    );
    assert.equal(
      (await request(controller, '/api/hormuz/stats')).body.collection
        .failed_polls,
      0,
    );
    assert.equal(
      (await request(controller, '/api/vessels', { method: 'POST' })).status,
      405,
    );
    assert.equal(
      (
        await request(controller, '/api/vessels', {
          remoteAddress: '192.168.1.20',
        })
      ).status,
      403,
    );
    assert.equal(
      (await request(controller, '/api/vessels', { host: 'evil.example:8808' }))
        .status,
      403,
    );
    assert.equal(
      (
        await request(controller, '/api/vessels', {
          headers: { origin: 'http://evil.example' },
        })
      ).status,
      403,
    );

    fail = true;
    await controller.recordPoll();
    const failure = await request(controller, '/api/vessels');
    assert.equal(failure.status, 503);
    assert.equal(failure.body.status, 'error');
    assert.equal(failure.body.rows.length, 1);
    assert.equal(
      (await request(controller, '/api/hormuz/stats')).body.collection
        .failed_polls,
      1,
    );
  } finally {
    await controller.stop();
  }
});

test('recorded vessel and replay responses cap rows consistently with explicit coverage metadata', async () => {
  const controller = createRecordingController({
    source: 'hormuz',
    dbPath: tempDb(),
    env: { AIS_RECORDING_INTERVAL_SECONDS: '600' },
    fetchImpl: async () => {
      throw new Error('fetch is not used by this test');
    },
  });
  try {
    const vessels = Array.from({ length: 12_001 }, (_, index) =>
      sample({
        mmsi: String(index + 100_000_000),
        observed_at: '2026-10-07T12:00:00Z',
      }),
    );
    const recorded = controller.store.recordPoll({
      dataStamp: '2026-10-07T12:00:00Z',
      fetchedAt: '2026-10-07T12:00:01Z',
      vessels,
    });

    const live = await request(controller, '/api/vessels');
    assert.equal(live.body.rows.length, 12_000);
    assert.equal(live.body.truncated, true);
    assert.equal(live.body.totalRows, 12_001);
    assert.equal(live.body.returnedRows, 12_000);
    assert.equal(live.body.recordingSource, 'hormuz');
    assert.equal(live.body.status, 'recorded');
    assert.equal(live.body.error, null);
    assert.equal(
      live.body.newestPositionAt,
      Date.parse('2026-10-07T12:00:00Z'),
    );
    assert.equal(live.body.lastMessageAt, null);

    const snapshot = await request(
      controller,
      `/api/hormuz/snapshot?poll_id=${recorded.poll_id}`,
    );
    assert.equal(snapshot.body.rows.length, 12_000);
    assert.equal(snapshot.body.truncated, true);
    assert.equal(snapshot.body.totalRows, 12_001);
    assert.equal(snapshot.body.returnedRows, 12_000);
    assert.equal(snapshot.body.recordingSource, 'hormuz');
    assert.equal(snapshot.body.status, 'recorded');
    assert.equal(snapshot.body.error, null);
    assert.equal(
      snapshot.body.newestPositionAt,
      Date.parse('2026-10-07T12:00:00Z'),
    );

    const legacySnapshot = await request(
      controller,
      `/api/snapshot?poll_id=${recorded.poll_id}`,
    );
    assert.equal(legacySnapshot.body.vessels.length, 12_000);
    assert.equal(legacySnapshot.body.truncated, true);
    assert.equal(legacySnapshot.body.totalRows, 12_001);
    assert.equal(legacySnapshot.body.returnedRows, 12_000);

    const legacyLive = await request(controller, '/api/live');
    assert.equal(legacyLive.body.vessels.length, 12_000);
    assert.equal(legacyLive.body.truncated, true);
    assert.equal(legacyLive.body.totalRows, 12_001);
    assert.equal(legacyLive.body.returnedRows, 12_000);
    assert.equal(legacyLive.body.recordingSource, 'hormuz');
    assert.equal(legacyLive.body.status, 'recorded');
    assert.equal(legacyLive.body.error, null);
    assert.equal(
      legacyLive.body.newestPositionAt,
      Date.parse('2026-10-07T12:00:00Z'),
    );
    assert.equal(
      (await request(controller, '/api/vessels?maxRows=12001')).status,
      400,
    );
  } finally {
    await controller.stop();
  }
});

test('AISStream recorder reuses injected shared snapshot provider and skips bad observation times', async () => {
  let starts = 0;
  let stops = 0;
  const controller = createRecordingController({
    source: 'aisstream',
    dbPath: tempDb(),
    env: { AIS_RECORDING_INTERVAL_SECONDS: '10' },
    aisSource: {
      start() {
        starts += 1;
      },
      stop() {
        stops += 1;
      },
      read() {
        return {
          status: 'live',
          rows: [
            { ...sample(), last_position_UTC: '2026-10-07T12:00:00Z' },
            { ...sample({ mmsi: '111111111' }), last_position_UTC: null },
          ],
        };
      },
    },
  });
  controller.start();
  await controller.recordPoll();
  assert.equal(starts, 1);
  assert.equal(controller.store.latestSnapshot().vessels.length, 1);
  const polls = await request(controller, '/api/hormuz/polls?day=2026-10-07');
  assert.equal(polls.body.polls.length, 1);
  assert.equal(polls.body.recordingSource, 'aisstream');
  const history = await request(
    controller,
    '/api/hormuz/history?start=2026-10-07&end=2026-10-07',
  );
  assert.equal(history.body.recordingSource, 'aisstream');
  assert.equal(history.body.sources.recorded_ais.source, 'aisstream');
  const replay = await request(
    controller,
    `/api/hormuz/snapshot?poll_id=${polls.body.polls[0].poll_id}`,
  );
  assert.equal(replay.body.rows[0].recorded, true);
  await controller.stop();
  assert.equal(stops, 1);
});
