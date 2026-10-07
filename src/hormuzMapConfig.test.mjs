import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHormuzMapConfig } from './hormuzMapConfig.js';

test('map startup loads local runtime credentials without baking backend settings into a bundle', async () => {
  const config = {
    cesiumToken: 'test-placeholder',
    googleMapsKey: '',
    center: { lat: 26.6, lon: 56.4, height: 240000 },
    ports: [],
  };
  const actual = await loadHormuzMapConfig(async (url, options) => {
    assert.equal(url, '/api/hormuz/config');
    assert.equal(options.cache, 'no-store');
    return new Response(JSON.stringify(config));
  });
  assert.deepEqual(actual, config);
});

test('missing or malformed backend config is explicit, never silent keyless success', async () => {
  await assert.rejects(
    loadHormuzMapConfig(async () => new Response('{}', { status: 502 })),
    /unavailable/,
  );
  await assert.rejects(
    loadHormuzMapConfig(async () => new Response('{}')),
    /Invalid/,
  );
});
