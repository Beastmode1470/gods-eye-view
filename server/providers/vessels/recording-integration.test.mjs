import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { createRecordingController } from './recording.js';

test('AISStream controller records genuine fixes and exposes persisted replay over HTTP', async (t) => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), 'gev-recording-integration-'),
  );
  const dbPath = path.join(root, 'history.sqlite');
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(upstream, 'listening');
  const server = createServer();
  const originalEnv = new Map(
    [
      'AISSTREAM_API_KEY',
      'AISSTREAM_URL',
      'AISSTREAM_SILENCE_TIMEOUT_MS',
      'AISSTREAM_BOUNDING_BOXES',
      'AISSTREAM_MESSAGE_TYPES',
    ].map((key) => [key, process.env[key]]),
  );
  process.env.AISSTREAM_API_KEY = 'fixture-only-key';
  process.env.AISSTREAM_URL = `ws://127.0.0.1:${upstream.address().port}`;
  process.env.AISSTREAM_SILENCE_TIMEOUT_MS = '0';
  delete process.env.AISSTREAM_BOUNDING_BOXES;
  delete process.env.AISSTREAM_MESSAGE_TYPES;

  let controller;
  let address;
  const restoreEnvironment = () => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  t.after(async () => {
    await controller?.stop();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise((resolve) => upstream.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    restoreEnvironment();
    rmSync(root, { recursive: true, force: true });
  });

  server.on('request', (req, res) =>
    controller.handleRequest(req, res, () => {
      res.statusCode = 404;
      res.end();
    }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  address = `http://127.0.0.1:${server.address().port}`;

  const subscription = new Promise((resolve, reject) => {
    upstream.once('connection', (socket) => {
      socket.once('message', (raw) => {
        try {
          assert.equal(JSON.parse(raw).APIKey, 'fixture-only-key');
          const observedAt = new Date(Date.now() - 30_000).toISOString();
          for (const [mmsi, lat, time] of [
            ['123456789', 26.4, observedAt],
            ['987654321', 27.1, 'invalid timestamp'],
          ]) {
            socket.send(
              JSON.stringify({
                MessageType: 'PositionReport',
                MetaData: {
                  MMSI: mmsi,
                  latitude: lat,
                  longitude: 56.2,
                  time_utc: time,
                },
                Message: {
                  PositionReport: {
                    UserID: mmsi,
                    Latitude: lat,
                    Longitude: 56.2,
                  },
                },
              }),
            );
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  });

  controller = createRecordingController({
    source: 'aisstream',
    dbPath,
    env: { AIS_RECORDING_INTERVAL_SECONDS: '10' },
  });
  controller.start();
  await subscription;

  let saved;
  for (let attempt = 0; attempt < 50; attempt++) {
    await delay(10);
    saved = await controller.recordPoll();
    if (saved.positions > 0) break;
  }
  assert.equal(saved.positions, 1, 'only the timestamped fix is persisted');

  const latestResponse = await fetch(`${address}/api/vessels`);
  assert.equal(latestResponse.status, 200);
  const latest = await latestResponse.json();
  assert.deepEqual(
    latest.rows.map((row) => row.mmsi),
    ['123456789'],
    'fallback cache timestamps must not become recorded positions',
  );
  assert.equal(
    latest.rows[0].last_position_UTC,
    latest.snapshotAt
      ? new Date(latest.snapshotAt).toISOString()
      : latest.rows[0].last_position_UTC,
  );

  const historyResponse = await fetch(
    `${address}/api/hormuz/history?start=${latest.rows[0].last_position_UTC.slice(0, 10)}&end=${latest.rows[0].last_position_UTC.slice(0, 10)}`,
  );
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  assert.equal(history.recorded_ais.positions, 1);
  assert.equal(history.sources.recorded_ais.source, 'aisstream');

  const pollsResponse = await fetch(
    `${address}/api/hormuz/polls?day=${latest.rows[0].last_position_UTC.slice(0, 10)}`,
  );
  const { polls } = await pollsResponse.json();
  assert.equal(polls.length, 1);
  const replayResponse = await fetch(
    `${address}/api/hormuz/snapshot?poll_id=${polls[0].poll_id}`,
  );
  const replay = await replayResponse.json();
  assert.deepEqual(
    replay.rows.map((row) => row.mmsi),
    ['123456789'],
    'replay endpoint serves the immutable accepted frame',
  );
  assert.equal(replay.rows[0].recorded, true);

  await controller.stop();
  controller = createRecordingController({
    source: 'aisstream',
    dbPath,
    env: { AIS_RECORDING_INTERVAL_SECONDS: '10' },
    aisSource: {
      start() {},
      stop() {},
      read() {
        return { status: 'missing-key', rows: [] };
      },
    },
  });
  const persisted = await fetch(
    `${address}/api/hormuz/snapshot?poll_id=${polls[0].poll_id}`,
  );
  assert.equal(persisted.status, 200);
  assert.deepEqual(
    (await persisted.json()).rows.map((row) => row.mmsi),
    ['123456789'],
    'recorded frames remain available after reopening the SQLite store',
  );
});
