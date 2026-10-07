import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordedVesselSource } from './recordedVessels.js';

test('recorded snapshots preserve source, unknown timestamps, and exact empty frames', async () => {
  const snapshotAt = Date.parse('2026-10-03T12:00:00Z');
  let rows = [
    {
      mmsi: '111111111',
      lat: 48,
      lon: -123,
      recorded: true,
      last_position_epoch: snapshotAt / 1000,
    },
  ];
  const source = createRecordedVesselSource({
    source: 'aisstream',
    fetchImpl: async (url) => {
      assert.equal(url, '/api/vessels?maxRows=12000');
      return new Response(
        JSON.stringify({
          rows,
          source: 'AISStream local recording',
          recorded: true,
          snapshotAt,
          collectedAt: snapshotAt + 1000,
        }),
      );
    },
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.source, 'AISStream local recording');
  assert.equal(snapshot.snapshotAt, snapshotAt);
  assert.equal(snapshot.collectedAt, snapshotAt + 1000);
  assert.equal(snapshot.records[0].recorded, true);
  rows = [];
  assert.equal((await source.getSnapshot()).records.length, 0);
});

test('recorded trail cutoff is included in request and independently filters future/unknown fixes', async () => {
  const cutoff = Date.parse('2026-10-03T12:00:00Z');
  const source = createRecordedVesselSource({
    before: () => cutoff,
    fetchImpl: async (url) => {
      const params = new URL(url, 'http://localhost').searchParams;
      assert.equal(params.get('before'), '2026-10-03T12:00:00.000Z');
      assert.equal(params.get('mmsi'), '111111111');
      return new Response(
        JSON.stringify({
          samples: [
            { lat: 26, lon: 56, epochSec: cutoff / 1000 - 1 },
            { lat: 26, lon: 56, epochSec: cutoff / 1000 },
            { lat: 27, lon: 57, epochSec: cutoff / 1000 + 1 },
            { lat: 28, lon: 58 },
          ],
        }),
      );
    },
  });
  assert.equal((await source.getTrack('111111111')).records.length, 2);
});

test('oversized latest payload is bounded without falsely claiming complete coverage', async () => {
  const source = createRecordedVesselSource({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          recorded: true,
          rows: Array.from({ length: 12001 }, (_, i) => ({
            mmsi: String(i + 1),
            lat: 26,
            lon: 56,
          })),
        }),
      ),
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.records.length, 12000);
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.totalRows, 12001);
});

test('failed or live-shaped responses cannot masquerade as local recordings', async () => {
  await assert.rejects(
    createRecordedVesselSource({
      fetchImpl: async () =>
        new Response(JSON.stringify({ rows: [], recorded: false })),
    }).getSnapshot(),
    /Expected a recorded/,
  );
  await assert.rejects(
    createRecordedVesselSource({
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: 'Database unavailable' }), {
          status: 503,
        }),
    }).getSnapshot(),
    /Database unavailable/,
  );
});
