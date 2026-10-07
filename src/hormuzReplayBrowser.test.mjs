import test from 'node:test';
import assert from 'node:assert/strict';
import { initHormuzHistory } from './hormuzHistory.js';

class Element {
  constructor() {
    this.style = {};
    this.children = [];
    this.events = new Map();
    this.fields = new Map();
    this.value = '';
    this.textContent = '';
    this.hidden = false;
  }
  set innerHTML(value) {
    this.html = value;
    for (const [, id] of value.matchAll(/id="([^"]+)"/g))
      this.fields.set(id, new Element());
    this.fields.get('hormuz-history-source').value = 'auto';
    this.fields.get('hormuz-history-speed').value = '1';
  }
  querySelector(selector) {
    return this.fields.get(selector.slice(1));
  }
  addEventListener(type, handler) {
    this.events.set(type, handler);
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  replaceChildren() {
    this.children = [];
  }
  remove() {
    this.removed = true;
  }
}

async function settle() {
  for (let i = 0; i < 5; i++)
    await new Promise((resolve) => setImmediate(resolve));
}

function fixture() {
  const body = new Element();
  const document = {
    body,
    createElement: () => new Element(),
    createElementNS: () => new Element(),
  };
  const history = {
    portwatch: [],
    crossings_daily: [],
    sources: {},
    recordingSource: 'aisstream',
    recorded_ais: {
      first_observed_at: '2026-10-01T01:00:00Z',
      last_observed_at: '2026-10-03T02:00:00Z',
    },
  };
  const polls = {
    '2026-10-01': [
      { poll_id: 1, data_stamp: '2026-10-01T01:00:00Z' },
      { poll_id: 2, data_stamp: '2026-10-01T02:00:00Z' },
    ],
    '2026-10-02': [],
    '2026-10-03': [
      { poll_id: 3, data_stamp: '2026-10-03T01:00:00Z' },
      { poll_id: 4, data_stamp: '2026-10-03T02:00:00Z' },
    ],
  };
  let historyMode = false,
    layerEnabled = true,
    latest = 0,
    preparations = 0;
  const snapshots = [];
  const illustrations = [];
  const timers = new Map();
  let timerId = 0;
  const layer = {
    prepareRecordedHistory() {
      historyMode = true;
      preparations++;
    },
    showRecordedFrame(frame) {
      historyMode = true;
      snapshots.push(frame.pollId);
    },
    finishRecordedMotion() {},
    async resumeRecordedLatest() {
      historyMode = false;
      latest++;
    },
    getStats() {
      return { historyMode, error: null };
    },
  };
  const manager = {
    layers: {
      get() {
        return { enabled: layerEnabled };
      },
    },
    setEnabled() {
      assert.fail('Replay must never change a user layer toggle');
    },
  };
  const options = {
    enabled: true,
    async fetchImpl(path) {
      const url = new URL(path, 'http://localhost');
      let payload;
      if (url.pathname.endsWith('/history')) payload = history;
      else if (url.pathname.endsWith('/polls'))
        payload = { polls: polls[url.searchParams.get('day')] || [] };
      else {
        const pollId = Number(url.searchParams.get('poll_id'));
        const poll = Object.values(polls)
          .flat()
          .find((row) => row.poll_id === pollId);
        payload = {
          recorded: true,
          source: 'AISStream local recording',
          rows: [],
          pollId,
          snapshotAt: Date.parse(poll.data_stamp),
        };
      }
      return new Response(JSON.stringify(payload));
    },
    createIllustration() {
      return {
        show(day, observation) {
          illustrations.push({ day, observation });
        },
        clear() {},
        destroy() {},
      };
    },
    scheduleInterval(fn, interval) {
      const id = ++timerId;
      timers.set(id, { fn, interval });
      return id;
    },
    cancelInterval(id) {
      timers.delete(id);
    },
  };
  return {
    document,
    manager,
    layer,
    options,
    snapshots,
    illustrations,
    panel: () => body.children[0],
    setLayerEnabled(value) {
      layerEnabled = value;
    },
    latest: () => latest,
    preparations: () => preparations,
    removePoll(id) {
      for (const day of Object.keys(polls))
        polls[day] = polls[day].filter((row) => row.poll_id !== id);
    },
    async tick() {
      const timer = [...timers.values()][0];
      assert.ok(timer, 'Playback must have an active interval');
      timer.fn();
      await settle();
    },
  };
}

test('browser replay keeps chosen day and frame across refresh and plays all later snapshots in order', async () => {
  const priorDocument = globalThis.document;
  const probe = fixture();
  globalThis.document = probe.document;
  let dispose;
  try {
    dispose = initHormuzHistory(
      probe.manager,
      probe.layer,
      {},
      'aisstream',
      probe.options,
    );
    const panel = probe.panel();
    const find = (id) => panel.querySelector(`#hormuz-history-${id}`);
    assert.match(panel.html, /AISSTREAM RECORDING \/ HISTORY/);
    panel.open = true;
    panel.events.get('toggle')();
    await settle();
    assert.deepEqual(
      probe.snapshots,
      [],
      'Opening history does not replace Latest',
    );
    find('source').value = 'recorded';
    find('source').onchange();
    await settle();
    find('day').value = '2026-10-01';
    const prepared = probe.preparations();
    find('day').onchange();
    assert.ok(
      probe.preparations() > prepared,
      'Latest is paused before day loading finishes',
    );
    await settle();
    assert.equal(probe.snapshots.at(-1), 1);
    find('scrub').value = '1';
    find('scrub').oninput();
    await settle();
    assert.equal(probe.snapshots.at(-1), 2);
    find('refresh').onclick();
    await settle();
    assert.equal(
      find('day').value,
      '2026-10-01',
      'Refresh cannot silently jump to the latest day',
    );
    assert.equal(
      probe.snapshots.at(-1),
      2,
      'Refresh preserves the exact selected poll, not frame zero',
    );
    const beforePlay = probe.snapshots.length;
    find('play').onclick();
    await probe.tick();
    assert.equal(
      find('day').value,
      '2026-10-03',
      'The empty gap day is not fabricated',
    );
    await probe.tick();
    await probe.tick();
    assert.deepEqual(
      probe.snapshots.slice(beforePlay),
      [3, 4],
      'No observed frame may be skipped',
    );
    assert.equal(find('play').textContent, 'Play');
    await find('latest').onclick();
    assert.equal(probe.latest(), 1);
    const afterLatest = probe.snapshots.length;
    find('refresh').onclick();
    await settle();
    assert.equal(
      probe.snapshots.length,
      afterLatest,
      'Refreshing history leaves Latest selected',
    );
    find('day').value = '2026-10-01';
    find('day').onchange();
    await settle();
    find('scrub').value = '1';
    find('scrub').oninput();
    await settle();
    probe.removePoll(2);
    find('refresh').onclick();
    await settle();
    assert.equal(find('day').value, '2026-10-01');
    assert.match(find('readout').textContent, /no longer available/);
    const unavailable = probe.snapshots.length;
    find('play').onclick();
    await settle();
    assert.equal(
      probe.snapshots.length,
      unavailable,
      'An unavailable exact frame cannot be silently replaced or skipped by Play',
    );
  } finally {
    dispose?.();
    globalThis.document = priorDocument;
  }
});

test('browser replay honors disabled layers, labels missing days, and is absent when mode is disabled', async () => {
  const priorDocument = globalThis.document;
  const probe = fixture();
  globalThis.document = probe.document;
  let dispose;
  try {
    assert.equal(
      initHormuzHistory(probe.manager, probe.layer, {}, 'aisstream', {
        ...probe.options,
        enabled: false,
      }),
      undefined,
    );
    assert.equal(probe.document.body.children.length, 0);
    dispose = initHormuzHistory(
      probe.manager,
      probe.layer,
      {},
      'aisstream',
      probe.options,
    );
    const panel = probe.panel();
    const find = (id) => panel.querySelector(`#hormuz-history-${id}`);
    panel.open = true;
    panel.events.get('toggle')();
    await settle();
    probe.setLayerEnabled(false);
    find('day').value = '2026-10-01';
    find('day').onchange();
    await settle();
    assert.deepEqual(
      probe.snapshots,
      [],
      'A replay frame cannot enable or render an off layer',
    );
    assert.match(find('readout').textContent, /layer off/);
    find('day').value = '2026-10-02';
    find('day').onchange();
    await settle();
    assert.match(
      find('readout').textContent,
      /Missing observations are not zero traffic/,
    );
    assert.equal(probe.illustrations.at(-1).observation, null);
  } finally {
    dispose?.();
    globalThis.document = priorDocument;
  }
});
