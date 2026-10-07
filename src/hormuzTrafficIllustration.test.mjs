import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createHormuzTrafficIllustration,
  trafficSymbolCount,
} from './hormuzTrafficIllustration.js';
import { getRenderGovernorDiagnostics } from './renderGovernor.js';

test('daily traffic illustration uses one symbol per count with a bounded representative cap', () => {
  assert.equal(trafficSymbolCount(64, 64), 64);
  assert.equal(trafficSymbolCount(2, 64), 2);
  assert.equal(trafficSymbolCount(0, 64), 0);
  assert.equal(trafficSymbolCount(null, 64), 0);
  assert.equal(trafficSymbolCount(undefined, 64), 0);
  assert.equal(trafficSymbolCount(-2, 64), 0);
  assert.equal(trafficSymbolCount(1000, 64), 300);
  assert.equal(trafficSymbolCount(10, undefined), 10);
});

test('adjacent days reuse ship graphics and corridor without resetting motion, and cleanup removes both', () => {
  const priorDocument = globalThis.document;
  const element = () => ({
    hidden: false,
    textContent: '',
    children: [],
    setAttribute() {},
    replaceChildren() {
      this.children = [];
    },
    append(...children) {
      this.children.push(...children);
    },
  });
  globalThis.document = { createElement: element, body: { appendChild() {} } };
  const viewer = { entities: new Cesium.EntityCollection() };
  let illustration;
  try {
    illustration = createHormuzTrafficIllustration(viewer);
    illustration.show('2026-02-27', {
      source: 'portwatch',
      row: { a: 37, b: 64 },
    });
    assert.ok(
      getRenderGovernorDiagnostics().holds.includes('hormuz-illustration'),
    );
    assert.equal(viewer.entities.values.length, 65);
    const ship = viewer.entities.getById('hormuz-illustration-symbol-0');
    const position = ship.position;
    const corridor = viewer.entities.getById('hormuz-illustration-corridor');
    assert.ok(ship.billboard);
    illustration.show('2026-02-28', {
      source: 'portwatch',
      row: { a: 36, b: 57 },
    });
    assert.equal(viewer.entities.getById('hormuz-illustration-symbol-0'), ship);
    assert.equal(ship.position, position);
    assert.equal(
      viewer.entities.getById('hormuz-illustration-corridor'),
      corridor,
    );
    assert.equal(viewer.entities.values.length, 58);
    illustration.show('2026-03-08', {
      source: 'portwatch',
      row: { a: 0, b: 2 },
    });
    assert.equal(viewer.entities.values.length, 3);
    illustration.clear();
    assert.equal(viewer.entities.values.length, 0);
    assert.equal(
      getRenderGovernorDiagnostics().holds.includes('hormuz-illustration'),
      false,
    );
    illustration.show('2026-03-09', null);
    assert.equal(
      viewer.entities.values.length,
      0,
      'missing totals must not create a corridor or ships',
    );
  } finally {
    illustration?.clear();
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
  }
});
