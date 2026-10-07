import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordedPlayback } from './recorded.js';
import { VesselRecords } from './records.js';
import { createIngestion, createVesselFeed } from './ingestion.js';

function setup(source = 'aisstream') {
  const feed = createVesselFeed();
  feed.enabled = true;
  const state = {
    feed,
    records: new VesselRecords(),
    selectedRecord: null,
    viewer: { scene: { requestRender() {} } },
  };
  const layer = {};
  let requests = 0,
    cleared = 0;
  const visuals = new WeakMap();
  const parts = {
    lifecycle: {
      settleFirstConnectPhase(phase) {
        feed.firstConnectPhase = phase;
      },
      invalidateAisSession() {
        feed.sessionId++;
      },
    },
    selection: {
      clearVesselInspection() {
        state.selectedRecord = null;
      },
    },
    tracking: {
      clearSelectedVesselTrail() {
        cleared++;
      },
    },
    rendering: {
      prepareRecordVisual(record, point = record) {
        if (!visuals.has(record)) visuals.set(record, { billboard: {} });
        const visual = visuals.get(record);
        visual.position = { lat: point.lat, lon: point.lon };
        return visual;
      },
    },
    snapshots: {
      reconcileVessels(_viewer, rows, options) {
        state.records.reconcile(
          rows,
          { ...options, selectedRecord: state.selectedRecord },
          {
            add(record) {
              parts.rendering.prepareRecordVisual(record);
            },
            beforeUpdate() {},
            updated(record) {
              parts.rendering.prepareRecordVisual(record);
            },
            remove(record, evicted) {
              if (evicted) state.selectedRecord = null;
            },
            removed() {},
            staleSelected() {},
          },
        );
      },
    },
  };
  const playback = createRecordedPlayback({
    vesselState: { state },
    parts,
    layer,
    options: { recordingSource: source },
  });
  parts.ingestion = createIngestion({
    feed,
    readSource: () => ({
      async getSnapshot() {
        requests++;
        return {
          recorded: true,
          source: 'AISStream local recording',
          records: [],
          snapshotAt: 1700000000000,
        };
      },
    }),
    readViewer: () => state.viewer,
    getRowLimit: () => 12000,
    readCount: () => state.records.all.length,
    setSourceLabel() {},
    applyRecordedSnapshot: playback.applySnapshot,
    markUnavailable(message) {
      feed.error = message;
    },
  });
  return {
    state,
    layer,
    parts,
    playback,
    visuals,
    requests: () => requests,
    cleared: () => cleared,
  };
}

function frame(ms, rows = [{ mmsi: '111', lat: 26, lon: 56 }]) {
  return {
    rows: rows.map((row) => ({
      ...row,
      last_position_epoch: ms / 1000,
      recorded: true,
    })),
    snapshotAt: ms,
    collectedAt: ms + 1000,
    recorded: true,
    source: 'AISStream local recorded snapshots',
  };
}

test('partial global frames render with explicit coverage and never retain previous-frame fixes', () => {
  const probe = setup();
  probe.playback.methods.showRecordedFrame(frame(1700000000000));
  probe.playback.methods.showRecordedFrame({
    ...frame(1700000060000, [{ mmsi: '222', lat: 26, lon: 56 }]),
    truncated: true,
    totalRows: 50000,
  });
  assert.equal(probe.state.records.byMmsi.has('111'), false);
  assert.equal(probe.state.feed.partial, true);
  assert.equal(probe.state.feed.totalRows, 50000);
  assert.match(probe.state.feed.error, /PARTIAL FRAME/);
  assert.equal(probe.state.feed.count, 1);
});

test('replay uses exact frames, stable MMSI identity and never retains absent selected vessels', () => {
  const probe = setup();
  probe.playback.methods.showRecordedFrame(frame(1700000000000));
  const record = probe.state.records.byMmsi.get('111');
  probe.state.selectedRecord = record;
  probe.playback.methods.showRecordedFrame(
    frame(1700000060000, [{ mmsi: '111', lat: 26.001, lon: 56.001 }]),
  );
  assert.equal(probe.state.records.byMmsi.get('111'), record);
  assert.equal(record.lat, 26.001);
  assert.equal(probe.state.feed.snapshotAt, 1700000060000);
  assert.equal(probe.layer.source, 'AISSTREAM RECORDING');
  probe.playback.methods.showRecordedFrame(frame(1700000120000, []));
  assert.equal(probe.state.records.all.length, 0);
  assert.equal(probe.state.selectedRecord, null);
  assert.equal(probe.state.feed.count, 0);
});

test('display motion changes only rendered position and finishes on the exact observed fix', () => {
  const probe = setup();
  probe.playback.methods.showRecordedFrame(frame(1700000000000));
  probe.playback.methods.showRecordedFrame(
    frame(1700000060000, [{ mmsi: '111', lat: 26.001, lon: 56.001 }]),
    { animate: true, durationMs: 1000 },
  );
  const record = probe.state.records.byMmsi.get('111');
  assert.equal(
    record.lat,
    26.001,
    'raw observation never becomes an interpolated fix',
  );
  assert.ok(probe.visuals.get(record).position.lat < record.lat);
  probe.playback.finishRecordedMotion();
  assert.equal(probe.visuals.get(record).position.lat, record.lat);
  const clears = probe.cleared();
  probe.playback.methods.showRecordedFrame(frame(1700000000000), {
    animate: true,
  });
  assert.ok(
    probe.cleared() > clears,
    'rewind must clear future trail vertices',
  );
});

test('history pauses polling and Latest resumes without modifying the user layer toggle', async () => {
  const probe = setup();
  probe.playback.methods.prepareRecordedHistory();
  assert.equal(probe.state.feed.enabled, true);
  await probe.parts.ingestion.methods.update();
  assert.equal(probe.requests(), 0);
  await probe.playback.methods.resumeRecordedLatest();
  assert.equal(probe.requests(), 1);
  assert.equal(probe.state.feed.enabled, true);
  probe.state.feed.enabled = false;
  probe.playback.methods.prepareRecordedHistory();
  await probe.playback.methods.resumeRecordedLatest();
  assert.equal(probe.requests(), 1);
  assert.equal(probe.state.feed.enabled, false);
  assert.throws(
    () => probe.playback.methods.showRecordedFrame(frame(1700000000000)),
    /must be enabled/,
  );
});

test('normal live mode refuses recording controls, and stale live polls lose ownership on replay', async () => {
  assert.throws(
    () => setup(null).playback.methods.prepareRecordedHistory(),
    /mode required/,
  );
  const probe = setup();
  let release;
  probe.parts.ingestion = createIngestion({
    feed: probe.state.feed,
    readViewer: () => probe.state.viewer,
    readSource: () => ({
      getSnapshot: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    }),
    getRowLimit: () => 12000,
    setSourceLabel() {
      assert.fail('old latest request must not publish during replay');
    },
  });

  const pending = probe.parts.ingestion.methods.update();
  const controller = probe.state.feed.abort;
  probe.playback.methods.prepareRecordedHistory();
  assert.equal(controller.signal.aborted, true);
  release({ records: [], source: 'Old latest' });
  await pending;
  assert.equal(probe.state.feed.historyMode, true);
});

test('external AISStream collectors bind their actual source before initialization', () => {
  const probe = setup('hormuz');
  probe.state.viewer = null;
  probe.playback.methods.configureRecordingSource('aisstream');
  assert.equal(probe.layer.name, 'AISStream Recording');
  assert.equal(probe.layer.source, 'AISSTREAM RECORDING');
  assert.equal(probe.state.feed.recordingSource, 'aisstream');
  assert.throws(
    () => probe.playback.methods.configureRecordingSource('unknown'),
    /Unknown/,
  );
  probe.state.viewer = {};
  assert.throws(
    () => probe.playback.methods.configureRecordingSource('hormuz'),
    /before initialization/,
  );
});
