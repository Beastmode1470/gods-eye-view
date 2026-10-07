import assert from 'node:assert/strict';
import test from 'node:test';
import { applyHormuzCameraFeel, wheelNotches } from './hormuzCamera.js';

test('wheel notches normalize delta modes and cap bursts', () => {
  assert.equal(wheelNotches({ deltaMode: 0, deltaY: 100 }), 1);
  assert.equal(wheelNotches({ deltaMode: 1, deltaY: -3 }), -0.99);
  assert.equal(wheelNotches({ deltaMode: 2, deltaY: 10 }), 3);
});

test('recording camera preserves upstream pinch bindings and restores all owned settings/listeners', () => {
  const priorWindow = globalThis.window;
  const target = () => {
    const listeners = new Map();
    return {
      listeners,
      addEventListener(name, fn) {
        listeners.set(name, fn);
      },
      removeEventListener(name) {
        listeners.delete(name);
      },
    };
  };
  const canvas = target();
  const window = target();
  globalThis.window = window;
  const pinch = { eventType: 5, modifier: 'ctrl' };
  const controller = {
    zoomEventTypes: [5, pinch, 6],
    inertiaSpin: 0.9,
    inertiaTranslate: 0.9,
    inertiaZoom: 0.8,
    maximumMovementRatio: 0.1,
    _maximumRotateRate: 1.77,
  };
  const original = { ...controller };
  let dispose;
  try {
    dispose = applyHormuzCameraFeel(
      {
        scene: { screenSpaceCameraController: controller },
        camera: {},
        canvas,
      },
      { CameraEventType: { WHEEL: 5 }, Cartesian3: class {} },
    );
    assert.deepEqual(controller.zoomEventTypes, [pinch, 6]);
    assert.doesNotThrow(
      () => canvas.listeners.get('wheel')({ ctrlKey: true }),
      'Upstream owns Ctrl+wheel; custom zoom must not access the camera for pinch',
    );
    canvas.listeners.get('pointerdown')({ button: 1 });
    assert.equal(controller._maximumRotateRate, 0.7);
    window.listeners.get('blur')();
    assert.equal(controller._maximumRotateRate, 1.77);
    dispose();
    dispose = null;
    assert.deepEqual(controller, original);
    assert.equal(canvas.listeners.size, 0);
    assert.equal(window.listeners.size, 0);
  } finally {
    dispose?.();
    globalThis.window = priorWindow;
  }
});
