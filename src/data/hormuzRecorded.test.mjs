import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptHormuzSnapshot,
  adaptHormuzTrack,
  recordedEpoch,
  recordedSnapshotLabel,
} from './hormuzRecorded.js';

const vessel = {
  mmsi: '123456789',
  lat: 26.1,
  lon: 56.3,
  name: 'TEST TANKER',
  ship_category: 'Oil Tanker',
  speed: 8,
  course: 181,
  hdg: 182,
  observed_at: '2026-10-02T12:00:00Z',
  flag: 'TEST',
  zone: 'strait',
  draught: 12,
  dwt: 150000,
  length: 200,
  width: 35,
  destination: 'TEST PORT',
};

test('snapshot adapts original vessel fields and observation time, not refresh time', () => {
  const adapted = adaptHormuzSnapshot({
    vessels: [vessel],
    poll: {
      data_stamp: vessel.observed_at,
      fetched_at: '2026-10-02T14:00:00Z',
    },
    forecast: { private: 'not forwarded' },
  });
  assert.equal(adapted.rows[0].heading, 182);
  assert.equal(adapted.rows[0].type, 'Oil Tanker');
  assert.equal(
    adapted.rows[0].last_position_epoch,
    Date.parse(vessel.observed_at) / 1000,
  );
  assert.equal(adapted.rows[0].dwt, 150000);
  assert.equal(adapted.rows[0].draught, 12);
  assert.equal(adapted.snapshotAt, Date.parse(vessel.observed_at));
  assert.equal(adapted.status, 'recorded');
  assert.equal(adapted.forecast, undefined);
  assert.match(adapted.trailNote, /not verified crossings/);
});

test('invalid coordinates, sentinel headings, malformed MMSI and unknown metrics are honest', () => {
  const result = adaptHormuzSnapshot({
    vessels: [
      { ...vessel, hdg: 511, course: 360, speed: null },
      { ...vessel, lat: null },
      { ...vessel, lat: 91 },
      { ...vessel, lon: 181 },
      { ...vessel, mmsi: '../private' },
    ],
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].heading, null);
  assert.equal(result.rows[0].course, null);
  assert.equal(result.rows[0].speed, null);
  assert.equal(
    adaptHormuzSnapshot({ vessels: [{ ...vessel, hdg: null, course: null }] })
      .rows[0].heading,
    null,
  );
  assert.throws(() => adaptHormuzSnapshot({}), /Invalid/);
});

test('row cap and empty snapshots do not fabricate positions or observation times', () => {
  assert.equal(
    adaptHormuzSnapshot({ vessels: [vessel, vessel] }, 1).rows.length,
    1,
  );
  assert.equal(
    adaptHormuzSnapshot({ vessels: [], poll: null }).snapshotAt,
    null,
  );
  assert.match(recordedSnapshotLabel(null), /time unknown/);
  assert.equal(
    adaptHormuzSnapshot({ vessels: [{ ...vessel, mmsi: '1607' }] }).rows[0]
      .mmsi,
    '1607',
  );
});

test('timestamp and age parsing handles warehouse UTC and offset timestamps', () => {
  assert.equal(
    recordedEpoch('2026-10-02 12:00:00'),
    Date.parse('2026-10-02T12:00:00Z'),
  );
  assert.equal(
    recordedEpoch('2026-10-02T07:00:00-05:00'),
    Date.parse('2026-10-02T12:00:00Z'),
  );
  assert.equal(recordedEpoch('bad'), null);
  assert.match(
    recordedSnapshotLabel(
      Date.parse(vessel.observed_at),
      Date.parse('2026-10-02T14:30:00Z'),
    ),
    /2h 30m/,
  );
});

test('track samples are chronological, deduplicated, bounded and never synthetic', () => {
  const points = Array.from({ length: 500 }, (_, i) => ({
    lat: 26 + i / 10000,
    lon: 56,
    observed_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
  }));
  const track = adaptHormuzTrack(
    {
      mmsi: vessel.mmsi,
      points: [...points.reverse(), points[0], { lat: null, lon: 56 }],
    },
    vessel.mmsi,
  );
  assert.equal(track.samples.length, 400);
  assert.ok(
    track.samples.every(
      (row, i, all) => i === 0 || row.epochSec > all[i - 1].epochSec,
    ),
  );
  assert.equal(
    track.samples.at(-1).epochSec,
    Date.UTC(2026, 9, 1, 0, 499) / 1000,
  );
  assert.throws(
    () => adaptHormuzTrack({ mmsi: 'different', points: [] }, vessel.mmsi),
    /Invalid/,
  );
});

test('historical trail cutoff removes future fixes before taking the bounded newest samples', () => {
  const track = adaptHormuzTrack(
    {
      mmsi: '1607',
      points: [
        { observed_at: '2026-09-29T12:00:00Z', lat: 26, lon: 56 },
        { observed_at: '2026-10-02T12:00:00Z', lat: 27, lon: 57 },
      ],
    },
    '1607',
    Date.parse('2026-09-29T12:00:00Z'),
  );
  assert.equal(track.samples.length, 1);
  assert.equal(track.samples[0].lat, 26);
});
