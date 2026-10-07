import { vesselSnapshot } from '../../sources/live/vessels.js';
import { recordedVesselMotion, recordedMotionPoint } from './recordedMotion.js';
import {
  recordedSnapshotLabel,
  HORMUZ_TRAIL_NOTE,
} from '../../data/hormuzRecorded.js';
import { recordingTitle, recordingAttribution } from '../../recordingMode.js';

/** Replay owns the feed cursor while rendering continues to own Cesium resources. */
export function createRecordedPlayback({ vesselState, parts, layer, options }) {
  const { state } = vesselState;
  const { feed } = state;
  const motions = new Map();
  let banner;
  let bannerMessage;
  let bannerCredit;

  function updateBanner() {
    if (!options.recordingSource || typeof document === 'undefined') return;
    if (!banner) {
      banner = document.createElement('aside');
      banner.id = 'hormuz-source-status';
      banner.setAttribute('role', 'status');
      bannerMessage = document.createElement('span');
      bannerCredit = document.createElement('a');
      bannerCredit.target = '_blank';
      bannerCredit.rel = 'noopener noreferrer';
      banner.append(bannerMessage, document.createElement('br'), bannerCredit);
      document.body.appendChild(banner);
    }
    const message = [
      (feed.historyMode ? 'HISTORICAL FRAME | ' : '') +
        recordedSnapshotLabel(
          feed.snapshotAt,
          Date.now(),
          feed.recordingSource || options.recordingSource,
        ),
      `${feed.count} observed vessels${feed.partial ? ` shown of ${feed.totalRows ?? 'unknown'} (PARTIAL FRAME)` : ''} | ${feed.enabled ? 'layer on' : 'layer off'} | voice/AI uploads disabled`,
      feed.error || HORMUZ_TRAIL_NOTE,
    ].join('\n');
    if (bannerMessage.textContent !== message)
      bannerMessage.textContent = message;
    const credit = recordingAttribution(
      feed.recordingSource || options.recordingSource,
    );
    bannerCredit.hidden = !credit;
    if (credit) {
      bannerCredit.textContent = `Source: ${credit.label}`;
      bannerCredit.href = credit.url;
    } else {
      bannerCredit.removeAttribute('href');
      bannerCredit.textContent = '';
    }
  }

  function position(record, point) {
    const visual = parts.rendering.prepareRecordVisual(record, point);
    if (visual.billboard) visual.billboard.position = visual.position;
  }

  function finishRecordedMotion() {
    if (!motions.size) return;
    for (const record of motions.keys()) position(record, record);
    motions.clear();
    state.viewer?.scene?.requestRender?.();
  }

  function updateMotion() {
    if (!feed.enabled) return;
    updateBanner();
    for (const [record, motion] of motions) {
      const point = recordedMotionPoint(motion, performance.now());
      position(record, point);
      if (point.done) motions.delete(record);
    }
  }

  function applySnapshot(
    viewer,
    snapshot,
    { animate = false, durationMs = 1350 } = {},
  ) {
    finishRecordedMotion();
    const previousTime = feed.snapshotAt;
    const previous = new Map(
      state.records.all.map((record) => [record.mmsi, { ...record }]),
    );
    const gap = snapshot.snapshotAt - previousTime;
    if (!(gap > 0 && gap <= 90 * 60 * 1000))
      parts.tracking.clearSelectedVesselTrail();
    parts.lifecycle.settleFirstConnectPhase('ready');
    // A recorded empty frame is exact absence, never a warm live-feed fallback.
    parts.snapshots.reconcileVessels(
      viewer,
      snapshot.records.map(parts.ingestion.vesselDisplayRow),
      { complete: snapshot.complete !== false, exact: true },
    );
    Object.assign(feed, {
      recorded: true,
      snapshotAt: snapshot.snapshotAt ?? null,
      collectedAt: snapshot.collectedAt ?? null,
      recordingSource:
        snapshot.recordingSource || snapshot.source || options.recordingSource,
      loaded: true,
      loadingLabel: '',
      transportStatus: snapshot.transportStatus,
      lastMessageAt: snapshot.lastMessageAt ?? null,
      count: state.records.all.length,
      rawRowCount: snapshot.rawRowCount,
      acceptedRowCount: snapshot.records.length,
      lastUpdate: snapshot.snapshotAt ?? null,
      newestPositionAt: snapshot.observedAtMs ?? null,
      totalRows: snapshot.totalRows ?? snapshot.rawRowCount,
      error:
        snapshot.reason ||
        (snapshot.truncated
          ? 'PARTIAL FRAME: display cap reached; omitted vessels are not evidence of absence.'
          : null),
      stale: Boolean(snapshot.stale),
      partial: snapshot.complete === false,
    });
    layer.source = recordingTitle(feed.recordingSource);
    if (animate && gap > 0 && gap <= 90 * 60 * 1000) {
      const startedAt = performance.now();
      for (const record of state.records.all) {
        const motion = recordedVesselMotion(
          previous.get(record.mmsi),
          record,
          durationMs,
          startedAt,
        );
        if (motion) motions.set(record, motion);
      }
      updateMotion();
    }
    updateBanner();
    viewer?.scene?.requestRender?.();
  }

  function assertMode() {
    if (!options.recordingSource) throw new Error('Recorded AIS mode required');
  }

  const methods = {
    /** Bind an external collector's declared source before layer initialization. */
    configureRecordingSource(source) {
      assertMode();
      if (state.viewer)
        throw new Error('Configure recording source before initialization');
      if (!['hormuz', 'aisstream'].includes(source))
        throw new Error('Unknown AIS recording source');
      options.recordingSource = source;
      feed.recordingSource = source;
      layer.name =
        source === 'aisstream'
          ? 'AISStream Recording'
          : 'Hormuz Recorded Vessels';
      layer.source = recordingTitle(source);
    },
    prepareRecordedHistory() {
      assertMode();
      finishRecordedMotion();
      feed.historyMode = true;
      feed.abort?.abort();
      feed.abort = null;
      feed.loading = false;
      parts.lifecycle.invalidateAisSession();
      parts.selection.clearVesselInspection();
      parts.snapshots.reconcileVessels(state.viewer, [], { exact: true });
      feed.count = 0;
      feed.snapshotAt = null;
      feed.error = null;
      updateBanner();
    },
    showRecordedFrame(payload, animation) {
      assertMode();
      if (!feed.enabled)
        throw new Error('Recorded vessel layer must be enabled');
      if (payload?.recorded !== true)
        throw new Error('Expected a recorded snapshot');
      feed.historyMode = true;
      feed.abort?.abort();
      feed.abort = null;
      feed.loading = false;
      const cap = 12000;
      const snapshot = vesselSnapshot(
        {
          ...payload,
          rows: Array.isArray(payload.rows)
            ? payload.rows.slice(0, cap)
            : payload.rows,
          truncated: payload.truncated === true || payload.rows?.length > cap,
          totalRows: Math.max(
            Number(payload.totalRows) || 0,
            payload.rows?.length || 0,
          ),
        },
        { source: payload.source },
      );
      snapshot.records = snapshot.records.map((record) => ({
        ...record,
        recorded: true,
      }));
      applySnapshot(
        state.viewer,
        {
          ...snapshot,
          recorded: true,
          snapshotAt: payload.snapshotAt,
          collectedAt: payload.collectedAt,
          recordingSource: payload.recordingSource || payload.source,
          reason: payload.error || payload.reason || null,
        },
        animation,
      );
    },
    finishRecordedMotion,
    async resumeRecordedLatest() {
      assertMode();
      finishRecordedMotion();
      feed.historyMode = false;
      parts.selection.clearVesselInspection();
      parts.snapshots.reconcileVessels(state.viewer, [], { exact: true });
      feed.count = 0;
      feed.snapshotAt = null;
      if (feed.enabled) await parts.ingestion.loadLivePositions(state.viewer);
      updateBanner();
    },
  };
  return {
    methods,
    applySnapshot,
    updateMotion,
    finishRecordedMotion,
    updateBanner,
    destroy() {
      finishRecordedMotion();
      banner?.remove();
      banner = null;
    },
  };
}
