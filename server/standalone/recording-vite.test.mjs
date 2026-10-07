import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { recordingPrivacyPlugin } from '../../tools/recording-config.mjs';
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

function buildConfig(command = 'serve') {
  return viteConfig({ command, mode: 'test' });
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

test('AISStream production config does not initialize or create the recording database', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gev-recording-vite-build-'));
  const dbPath = path.join(root, 'must-not-be-created.sqlite');
  try {
    withRecordingEnvironment(
      {
        AIS_RECORDING_SOURCE: 'aisstream',
        AIS_RECORDING_DB: dbPath,
        AIS_RECORDING_INTERVAL_SECONDS: '10',
        HORMUZ_API_URL: '',
      },
      () => {
        const config = buildConfig('build');
        const names = recordingPlugins(config);
        assert.deepEqual(names, [
          'recording-storage-privacy',
          'recorded-vessels-proxy',
          'ais-live-proxy',
        ]);
        const recorder = config.plugins.find(
          (plugin) => plugin.name === 'recorded-vessels-proxy',
        );
        assert.equal(typeof recorder.configureServer, 'function');
        assert.equal(typeof recorder.configurePreviewServer, 'function');
        assert.equal(existsSync(dbPath), false);
        assert.equal(existsSync(`${dbPath}.writer.lock`), false);
        assert.equal(
          config.plugins.some((plugin) => plugin.name === 'cctv-proxy'),
          true,
          'public CCTV provider remains enabled',
        );
        assert.equal(
          config.plugins.some((plugin) => plugin.name === 'local-mcp'),
          false,
          'MCP is not installed in recording mode',
        );
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recording privacy blocks voice and MCP uploads without disabling public providers', () => {
  let middleware;
  recordingPrivacyPlugin(true).configureServer({
    middlewares: {
      use(handler) {
        middleware = handler;
      },
    },
  });
  assert.equal(typeof middleware, 'function');

  for (const url of ['/api/openai/realtime', '/api/realtime/session', '/mcp']) {
    let continued = false;
    const response = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(body) {
        this.body = body;
      },
    };
    middleware({ url }, response, () => {
      continued = true;
    });
    assert.equal(response.statusCode, 403, `${url} must be blocked`);
    assert.equal(continued, false, `${url} must not reach upload handlers`);
  }

  for (const url of ['/api/cctv/catalog', '/api/overpass/query']) {
    let continued = false;
    const response = {
      statusCode: 200,
      setHeader() {},
      end() {},
    };
    middleware({ url }, response, () => {
      continued = true;
    });
    assert.equal(continued, true, `${url} remains available`);
  }
});
