import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordedMotionPoint,
  recordedVesselMotion,
} from '../layers/vessels/recordedMotion.js';

const from = { recorded: true, lat: 26, lon: 56, lastPositionEpoch: 1000 };
const to = { recorded: true, lat: 26.1, lon: 56.1, lastPositionEpoch: 2800 };

test('recorded display motion reaches exact endpoints without changing the raw observations', () => {
  const motion = recordedVesselMotion(from, to, 1000, 100);
  assert.ok(motion);
  const first = recordedMotionPoint(motion, 100);
  const middle = recordedMotionPoint(motion, 600);
  const last = recordedMotionPoint(motion, 1100);
  assert.equal(first.lat, from.lat);
  assert.ok(Math.abs(middle.lat - 26.05) < 1e-10);
  assert.ok(Math.abs(middle.lon - 56.05) < 1e-10);
  assert.equal(last.lat, to.lat);
  assert.equal(last.done, true);
  assert.equal(from.lat, 26);
  assert.equal(to.lon, 56.1);
});

test('display easing does not bridge long gaps, rewinds, identical timestamps, or impossible jumps', () => {
  for (const next of [
    { ...to, lastPositionEpoch: 999 },
    { ...to, lastPositionEpoch: 1000 },
    { ...to, lastPositionEpoch: 6401 },
    { ...to, lon: 76 },
    { ...to, recorded: false },
    { ...to, lat: NaN },
    { ...to, lastPositionEpoch: null },
  ])
    assert.equal(recordedVesselMotion(from, next, 1000, 100), null);
  assert.equal(
    recordedVesselMotion({ ...from, lastPositionEpoch: null }, to, 1000, 100),
    null,
  );
  assert.equal(recordedVesselMotion(from, to, 0, 100), null);
});

test('nearby antimeridian fixes take the short display transition', () => {
  const motion = recordedVesselMotion(
    { ...from, lon: 179.99 },
    { ...to, lat: 26, lon: -179.99 },
    1000,
    0,
  );
  assert.ok(motion);
  assert.ok(
    Math.abs(Math.abs(recordedMotionPoint(motion, 500).lon) - 180) < 1e-10,
  );
});
