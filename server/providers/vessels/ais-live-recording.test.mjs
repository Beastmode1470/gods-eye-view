import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  readAisLiveRecordingSnapshot,
  startAisLiveRecording,
  stopAisLiveRecording,
} from './ais-live.js';

const originalApiKey = process.env.AISSTREAM_API_KEY;

after(() => {
  if (originalApiKey === undefined) delete process.env.AISSTREAM_API_KEY;
  else process.env.AISSTREAM_API_KEY = originalApiKey;
  stopAisLiveRecording();
});

test('headless recording hooks share the live cache and watchdog lifecycle', () => {
  delete process.env.AISSTREAM_API_KEY;

  const started = startAisLiveRecording();
  const snapshot = readAisLiveRecordingSnapshot();

  assert.equal(started.source, 'AISStream');
  assert.equal(started.status, 'missing-key');
  assert.deepEqual(snapshot.rows, started.rows);
  assert.equal(snapshot.status, 'missing-key');
  assert.equal(typeof snapshot.rows.length, 'number');
  assert.equal(snapshot.newestPositionAt, null);

  stopAisLiveRecording();
});
