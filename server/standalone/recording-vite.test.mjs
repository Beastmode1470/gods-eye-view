import assert from 'node:assert/strict';
import { test } from 'node:test';
import viteConfig from './vite.config.js';

const recordingEnvironmentKeys = [
  'AIS_RECORDING_SOURCE',
  'AIS_RECORDING_DB',
  'AIS_RECORDING_INTERVAL_SECONDS',
  'HORMUZ_API_URL',
];

function withRecordingEnvironment(values, action) {
  const previous = new Map(
    recordingEnvironmentKeys.map((key) => [key, process.env[key]]),
  );
  try {
    for (const key of recordingEnvironmentKeys) {
      if (Object.hasOwn(values, key)) process.env[key] = values[key];
      else delete process.env[key];
    }
    return action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function buildConfig() {
  return viteConfig({ command: 'serve', mode: 'test' });
}

function recordingPlugins(config) {
  return config.plugins
    .map((plugin) => plugin.name)
    .filter((name) =>
      /ais-live|recorded-vessels|local-hormuz-recorded|recording-storage-privacy/.test(
        name,
      ),
    );
}

test('AISStream recording installs recorder before the existing single live provider', () => {
  withRecordingEnvironment(
    {
      AIS_RECORDING_SOURCE: 'aisstream',
      AIS_RECORDING_DB: '.gev-cache/test-history.sqlite',
      AIS_RECORDING_INTERVAL_SECONDS: '10',
      HORMUZ_API_URL: '',
    },
    () => {
      const config = buildConfig();
      const names = recordingPlugins(config);
      assert.deepEqual(names, [
        'recording-storage-privacy',
        'recorded-vessels-proxy',
        'ais-live-proxy',
      ]);
      assert.equal(
        config.plugins.findIndex(
          (plugin) => plugin.name === 'recorded-vessels-proxy',
        ) <
          config.plugins.findIndex(
            (plugin) => plugin.name === 'ais-live-proxy',
          ),
        true,
      );
      assert.equal(config.server.host, 'localhost');
      assert.equal(config.preview.host, 'localhost');
      assert.equal(
        config.define['import.meta.env.HORMUZ_RECORDED_MODE'],
        'true',
      );
      assert.equal(
        config.define['import.meta.env.AIS_RECORDING_SOURCE'],
        '"aisstream"',
      );
    },
  );
});

test('Hormuz recording skips the live AIS websocket and external legacy mode stays opt-in', () => {
  withRecordingEnvironment(
    {
      AIS_RECORDING_SOURCE: 'hormuz',
      AIS_RECORDING_DB: '.gev-cache/test-history.sqlite',
      AIS_RECORDING_INTERVAL_SECONDS: '600',
      HORMUZ_API_URL: '',
    },
    () => {
      const config = buildConfig();
      assert.deepEqual(recordingPlugins(config), [
        'recording-storage-privacy',
        'recorded-vessels-proxy',
      ]);
      assert.equal(
        config.plugins.some((plugin) => plugin.name === 'ais-live-proxy'),
        false,
      );
    },
  );

  withRecordingEnvironment(
    {
      AIS_RECORDING_SOURCE: '',
      AIS_RECORDING_DB: '',
      AIS_RECORDING_INTERVAL_SECONDS: '',
      HORMUZ_API_URL: 'http://127.0.0.1:8808',
    },
    () => {
      const config = buildConfig();
      assert.deepEqual(recordingPlugins(config), [
        'recording-storage-privacy',
        'local-hormuz-recorded',
      ]);
      assert.equal(
        config.plugins.some((plugin) => plugin.name === 'ais-live-proxy'),
        false,
      );
    },
  );
});
