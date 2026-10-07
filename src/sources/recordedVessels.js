import { vesselSnapshot, normalizeVesselTrack } from './live/vessels.js';
import { recordingTitle } from '../recordingMode.js';

/** Local recorded source; replay cutoffs are owned by the layer, not wall time. */
export function createRecordedVesselSource({
  fetchImpl = (...args) => fetch(...args),
  source = 'hormuz',
  before = () => null,
} = {}) {
  async function read(path, signal) {
    const response = await fetchImpl(path, { cache: 'no-store', signal });
    const payload = await response.json();
    if (!response.ok)
      throw new Error(payload.error || `Recorded AIS HTTP ${response.status}`);
    return payload;
  }
  return {
    label: recordingTitle(source),
    async getSnapshot({ maxRows = 12000 } = {}, { signal } = {}) {
      const bounded =
        Number.isFinite(Number(maxRows)) && Number(maxRows) > 0
          ? Math.min(12000, Math.floor(Number(maxRows)))
          : 12000;
      const payload = await read(`/api/vessels?maxRows=${bounded}`, signal);
      if (payload.recorded !== true)
        throw new Error('Expected a recorded AIS snapshot');
      if (!Array.isArray(payload.rows))
        throw new Error('Malformed recorded AIS snapshot');
      const projected = {
        ...payload,
        rows: payload.rows.slice(0, bounded),
        truncated: payload.truncated === true || payload.rows.length > bounded,
        totalRows: Math.max(
          Number(payload.totalRows) || 0,
          payload.rows.length,
        ),
      };
      return {
        ...vesselSnapshot(projected, { source: payload.source || source }),
        recorded: true,
        snapshotAt: payload.snapshotAt,
        collectedAt: payload.collectedAt,
        recordingSource: payload.recordingSource || source,
        reason: payload.error || payload.reason || null,
      };
    },
    async getTrack(reference, { signal } = {}) {
      const cutoff = before();
      const params = new URLSearchParams({ mmsi: String(reference) });
      if (Number.isFinite(cutoff))
        params.set('before', new Date(cutoff).toISOString());
      const payload = await read(`/api/vessels/track?${params}`, signal);
      const records = normalizeVesselTrack(payload.samples);
      return {
        records: records.filter(
          (row) =>
            row.observedAtMs !== null &&
            (!Number.isFinite(cutoff) || row.observedAtMs <= cutoff),
        ),
        complete: false,
      };
    },
  };
}
