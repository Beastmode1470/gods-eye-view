import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  automaticHistorySeries,
  dailyTrafficObservation,
  historyCursorX,
  historyPlaybackInterval,
  historySeries,
  nextRecordedDay,
  recordedFrames,
  recordedPollFrames,
} from './hormuzHistory.js';

test('busy recorded days use a chronological manifest, not a truncated bulk-fix response', () => {
  const polls = Array.from({ length: 48 }, (_, i) => ({
    poll_id: i + 1,
    data_stamp: new Date(Date.UTC(2026, 9, 3, 0, i * 30)).toISOString(),
    fetched_at: '2026-10-04T01:00:00Z',
  })).reverse();
  const frames = recordedPollFrames({ polls });
  assert.equal(frames.length, 48);
  assert.equal(frames[0].pollId, 1);
  assert.equal(frames.at(-1).pollId, 48);
  assert.equal(frames[0].time, '2026-10-03T00:00:00.000Z');
  assert.deepEqual(recordedPollFrames({ polls: [] }), []);
  assert.throws(
    () => recordedPollFrames({ polls: [], truncated: true }),
    /Incomplete/,
  );
  assert.throws(() => recordedPollFrames({ tracks: [] }), /manifest/);
  assert.throws(
    () =>
      recordedPollFrames({
        polls: [{ poll_id: -1, data_stamp: '2026-10-03' }],
      }),
    /identifier/,
  );
  assert.throws(
    () =>
      recordedPollFrames({ polls: [{ poll_id: 1, data_stamp: 'invalid' }] }),
    /timestamp/,
  );
});

test('automatic daily replay covers aggregate and AIS days, preserving missing calendar days', () => {
  const history = {
    portwatch: [{ date: '2026-09-27', n_tanker: 2, n_total: 5 }],
    crossings_daily: [{ day: '2026-10-01', direction: 'inbound', count: 1 }],
    recorded_ais: {
      first_observed_at: '2026-09-29T11:30:51-05:00',
      last_observed_at: '2026-09-30T19:30:55-05:00',
    },
  };
  const series = automaticHistorySeries(history);
  assert.deepEqual(
    series.map((row) => row.date),
    ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'],
  );
  assert.equal(series[0].b, 5);
  assert.equal(series[1].b, null);
  assert.equal(
    series[4].b,
    null,
    'crossings must not masquerade as PortWatch counts',
  );
  assert.deepEqual(
    automaticHistorySeries({
      portwatch: [],
      crossings_daily: [],
      recorded_ais: {},
    }),
    [],
  );
});

test('automatic daily fallback uses exact-day PortWatch, then separately labelled crossings, never another date', () => {
  const history = {
    portwatch: [{ date: '2026-03-01', n_tanker: 0, n_total: 0 }],
    crossings_daily: [
      { day: '2026-03-01', direction: 'inbound', count: 9 },
      { day: '2026-03-02', direction: 'outbound', count: 2 },
    ],
    recorded_ais: {},
  };
  assert.equal(
    dailyTrafficObservation(history, '2026-03-01').source,
    'portwatch',
  );
  assert.equal(dailyTrafficObservation(history, '2026-03-01').row.b, 0);
  assert.deepEqual(dailyTrafficObservation(history, '2026-03-02'), {
    source: 'crossings',
    row: { date: '2026-03-02', a: null, b: 2 },
  });
  assert.equal(dailyTrafficObservation(history, '2026-03-03'), null);
});

test('aggregate replay cursor maps observed dates to the chart and playback speeds stay bounded', () => {
  const series = [
    { date: '2026-03-01', a: 12, b: 40 },
    { date: '2026-03-11', a: 5, b: 14 },
  ];
  assert.equal(historyCursorX('2026-03-01', series), 5);
  assert.equal(historyCursorX('2026-03-11', series), 355);
  assert.equal(historyCursorX('2026-03-05', series), 145);
  assert.equal(historyCursorX('2026-02-28', series), null);
  assert.equal(historyPlaybackInterval('1'), 1500);
  assert.equal(historyPlaybackInterval('10'), 150);
  assert.equal(historyPlaybackInterval('30'), 50);
  assert.equal(historyPlaybackInterval('invalid'), 1500);
  assert.equal(historyPlaybackInterval('1', true), 1500);
  assert.equal(historyPlaybackInterval('10', true), 250);
  assert.equal(historyPlaybackInterval('30', true), 250);
});

test('PortWatch and upstream counts stay separate, with missing days and directions not zero-filled', () => {
  const data = {
    portwatch: [
      { date: '2026-03-01', n_tanker: 12, n_total: 40, quality: 'degraded' },
    ],
    crossings_daily: [
      { day: '2026-03-08', direction: 'inbound', count: 3 },
      { day: '2026-03-10', direction: 'outbound', count: 4 },
    ],
  };
  assert.deepEqual(historySeries(data, 'portwatch'), [
    { date: '2026-03-01', a: 12, b: 40, quality: 'degraded' },
  ]);
  assert.deepEqual(historySeries(data, 'crossings'), [
    { date: '2026-03-08', a: 3, b: null },
    { date: '2026-03-10', a: null, b: 4 },
  ]);
});

test('individual replay uses exact recorded positions and timestamps, never carrying absent vessels forward', () => {
  const frames = recordedFrames({
    tracks: [
      {
        mmsi: '1607',
        name: 'TEST',
        ship_category: 'Tanker',
        points: [
          { t: '2026-09-29T12:00:00-05:00', lat: 26, lon: 56, speed: 4 },
          { t: '2026-09-29T11:00:00-05:00', lat: 25, lon: 55, speed: 3 },
        ],
      },
      {
        mmsi: '123456789',
        points: [{ t: '2026-09-29T11:00:00-05:00', lat: 24, lon: 54 }],
      },
    ],
  });
  assert.equal(frames.length, 2);
  assert.equal(frames[0].rows.length, 2);
  assert.equal(frames[1].rows.length, 1);
  assert.equal(frames[1].rows[0].lat, 26);
  assert.equal(frames[1].rows[0].speed, 4);
  assert.equal(frames[1].snapshotAt, Date.parse('2026-09-29T12:00:00-05:00'));
  assert.equal(frames[1].recorded, true);
  assert.deepEqual(recordedFrames({ tracks: [] }), []);
});

test('nextRecordedDay crosses midnight and stops after the last recorded day', () => {
  assert.equal(nextRecordedDay('2026-09-30', '2026-10-02'), '2026-10-01');
  assert.equal(nextRecordedDay('2026-09-30', '2026-09-30'), null);
  assert.equal(nextRecordedDay('2026-12-31', ''), '2027-01-01');
});
