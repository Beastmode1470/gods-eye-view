import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordingTitle,
  recordingAttribution,
  recordingUploadsDisabled,
} from './recordingMode.js';
import { recordedSnapshotLabel } from './data/hormuzRecorded.js';
import { loadHormuzMapConfig } from './hormuzMapConfig.js';
import {
  isRecordingStoragePath,
  resolveRecordingConfig,
  recordingPrivacyPlugin,
} from '../tools/recording-config.mjs';

test('recording opt-in is exclusive, defaults to live, and never exposes keys', () => {
  assert.equal(recordingUploadsDisabled(true), true);
  assert.equal(recordingUploadsDisabled(false), false);
  assert.equal(resolveRecordingConfig({}).enabled, false);
  assert.equal(
    resolveRecordingConfig({ AIS_RECORDING_SOURCE: 'AISStream' }).source,
    'aisstream',
  );
  assert.equal(
    resolveRecordingConfig({ AIS_RECORDING_SOURCE: 'hormuz' }).dbPath,
    '.gev-cache/ais-history.sqlite',
  );
  assert.equal(
    resolveRecordingConfig({ HORMUZ_API_URL: 'http://localhost:8808' }).source,
    'hormuz',
  );
  assert.throws(
    () =>
      resolveRecordingConfig({
        AIS_RECORDING_SOURCE: 'aisstream',
        HORMUZ_API_URL: 'http://localhost:8808',
      }),
    /mutually exclusive/,
  );
  assert.throws(
    () => resolveRecordingConfig({ AIS_RECORDING_SOURCE: 'unknown' }),
    /must be/,
  );
  assert.equal(
    recordingUploadsDisabled(),
    false,
    'plain Node/live mode keeps the standard voice path',
  );
});

test('worldwide AISStream history has a truthful title and no implied Hormuz camera', async () => {
  assert.deepEqual(recordingAttribution('AISStream local recording'), {
    label: 'AISStream.io',
    url: 'https://aisstream.io',
  });
  assert.deepEqual(recordingAttribution('hormuz'), {
    label: 'hormuz.data-tracking.net',
    url: 'https://hormuz.data-tracking.net',
  });
  assert.equal(recordingAttribution('unknown'), null);
  assert.equal(
    recordingTitle('AISStream local recording'),
    'AISSTREAM RECORDING',
  );
  assert.equal(recordingTitle('hormuz'), 'HORMUZ RECORDED');
  assert.equal(recordingTitle(''), 'AIS RECORDING (SOURCE UNKNOWN)');
  assert.match(
    recordedSnapshotLabel(1700000000000, 1700000060000, 'aisstream'),
    /^AISSTREAM RECORDING/,
  );
  const read = (config) =>
    loadHormuzMapConfig(async () => new Response(JSON.stringify(config)));
  const global = {
    cesiumToken: '',
    googleMapsKey: '',
    recordingSource: 'aisstream',
    center: null,
  };
  assert.deepEqual(await read(global), global);
  await assert.rejects(
    read({ ...global, center: { lat: 26, lon: 56, height: 1000 } }),
    /must not/,
  );
  await assert.rejects(
    read({
      ...global,
      recordingSource: 'hormuz',
      center: { lat: 91, lon: 56, height: 1000 },
    }),
    /Invalid/,
  );
});

test('storage files cannot be served in live, dev, preview, or /@fs modes', () => {
  for (const path of [
    '/.gev-cache/ais-history.sqlite',
    '/@fs/C:/private/history.db',
    '/public/history.sqlite?raw',
    '/@fs/C:%5Cprivate%5Chistory.sqlite-wal',
    '/%2egev-cache/private.json',
    '/public/history.db-shm',
  ]) {
    assert.equal(isRecordingStoragePath(path), true, path);
  }
  for (const path of ['/api/vessels', '/map.json', '/assets/globe.js'])
    assert.equal(isRecordingStoragePath(path), false, path);
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    let middleware;
    const hookResult = recordingPrivacyPlugin()[hook]({
      middlewares: {
        use(fn) {
          middleware = fn;
          return { handle() {} };
        },
      },
    });
    assert.equal(hookResult, undefined, 'Connect app is not a Vite post-hook');
    let next = false,
      ended = false;
    const res = {
      statusCode: 200,
      end() {
        ended = true;
      },
    };
    middleware({ url: '/@fs/C:/history.sqlite' }, res, () => {
      next = true;
    });
    assert.equal(res.statusCode, 403);
    assert.equal(ended, true);
    assert.equal(next, false);
  }
  assert.throws(
    () =>
      recordingPrivacyPlugin(true).configResolved({
        server: { host: '0.0.0.0' },
        preview: { host: 'localhost' },
      }),
    /loopback/,
  );
});
