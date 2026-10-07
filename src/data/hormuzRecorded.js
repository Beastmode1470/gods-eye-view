export const HORMUZ_SOURCE = 'Hormuz local recorded snapshots';
export const HORMUZ_TRAIL_NOTE =
  'Recorded fixes; connecting lines are not verified crossings';
export const HORMUZ_MAX_ROWS = 12000;
export const HORMUZ_MAX_POINTS = 400;
import { recordingTitle } from '../recordingMode.js';

/** Parse warehouse UTC timestamps without treating timezone-free values as local time. */
export function recordedEpoch(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let text = value.trim().replace(' ', 'T');
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) text += 'Z';
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function coordinates(row) {
  const lat = number(row?.lat);
  const lon = number(row?.lon);
  return (
    lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
  );
}

function bearing(value) {
  const n = number(value);
  return n !== null && n >= 0 && n < 360 ? n : null;
}

/** Adapt only vessel fields; never pass through unrelated backend data. */
export function adaptHormuzSnapshot(payload, maxRows = HORMUZ_MAX_ROWS) {
  if (!payload || !Array.isArray(payload.vessels))
    throw new Error('Invalid Hormuz snapshot');
  const rows = payload.vessels
    .filter((row) => coordinates(row) && /^\d{1,10}$/.test(String(row.mmsi)))
    .slice(0, maxRows)
    .map((row) => ({
      mmsi: String(row.mmsi),
      lat: number(row.lat),
      lon: number(row.lon),
      name: String(row.name || row.mmsi),
      type: String(row.ship_category || row.type_specific || row.type || ''),
      speed: number(row.speed),
      course: bearing(row.course),
      heading: bearing(row.hdg ?? row.heading),
      destination: String(row.destination || ''),
      last_position_UTC: String(row.observed_at || row.last_position_UTC || ''),
      last_position_epoch:
        recordedEpoch(row.observed_at || row.last_position_UTC) === null
          ? null
          : recordedEpoch(row.observed_at || row.last_position_UTC) / 1000,
      recorded: true,
      flag: String(row.flag || ''),
      zone: String(row.zone || ''),
      draught: number(row.draught),
      dwt: number(row.dwt),
      length: number(row.length),
      width: number(row.width),
    }));
  const poll = payload.poll;
  const snapshotAt =
    recordedEpoch(poll?.data_stamp) ??
    recordedEpoch(poll?.source_last_poll) ??
    (rows.length
      ? Math.max(...rows.map((row) => row.last_position_epoch || 0)) * 1000 ||
        null
      : null);
  return {
    rows,
    source: HORMUZ_SOURCE,
    recorded: true,
    status: typeof payload.status === 'string' ? payload.status : 'recorded',
    error: payload.error || null,
    reason: payload.reason || null,
    truncated: payload.truncated === true || payload.vessels.length > maxRows,
    totalRows: Math.max(Number(payload.totalRows) || 0, payload.vessels.length),
    returnedRows: rows.length,
    snapshotAt,
    collectedAt: recordedEpoch(poll?.fetched_at),
    newestPositionAt:
      (Number.isFinite(payload.newestPositionAt)
        ? payload.newestPositionAt
        : recordedEpoch(payload.newestPositionAt)) ??
      (rows.length
        ? Math.max(...rows.map((row) => row.last_position_epoch || 0)) * 1000 ||
          null
        : null),
    lastMessageAt: Number.isFinite(payload.lastMessageAt)
      ? payload.lastMessageAt
      : recordedEpoch(payload.lastMessageAt),
    refreshing: Boolean(payload.refreshing),
    trailNote: HORMUZ_TRAIL_NOTE,
  };
}

/** Adapt chronological recorded fixes, bounded to the newest 400 samples. */
export function adaptHormuzTrack(payload, mmsi, before = Infinity) {
  if (
    !payload ||
    !Array.isArray(payload.points) ||
    String(payload.mmsi) !== mmsi
  ) {
    throw new Error('Invalid Hormuz track');
  }
  const samples = payload.points
    .filter(
      (row) => coordinates(row) && recordedEpoch(row.observed_at) !== null,
    )
    .map((row) => ({
      lat: number(row.lat),
      lon: number(row.lon),
      epochSec: recordedEpoch(row.observed_at) / 1000,
    }))
    .filter((row) => row.epochSec * 1000 <= before)
    .sort((a, b) => a.epochSec - b.epochSec)
    .filter(
      (row, i, all) =>
        i === 0 ||
        row.epochSec !== all[i - 1].epochSec ||
        row.lat !== all[i - 1].lat ||
        row.lon !== all[i - 1].lon,
    )
    .slice(-HORMUZ_MAX_POINTS);
  return {
    mmsi,
    samples,
    recorded: true,
    source: HORMUZ_SOURCE,
    trailNote: HORMUZ_TRAIL_NOTE,
    retainedSec: 720 * 3600,
  };
}

/** Recorded source health must describe observation age, not HTTP refresh age. */
export function recordedSnapshotLabel(
  snapshotAt,
  now = Date.now(),
  source = 'hormuz',
) {
  const title = recordingTitle(source);
  if (!Number.isFinite(snapshotAt) || snapshotAt <= 0)
    return `${title} | snapshot time unknown`;
  const minutes = Math.floor(Math.max(0, now - snapshotAt) / 60000);
  const age =
    minutes < 60
      ? `${minutes}m`
      : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${title} | snapshot age ${age} | ${new Date(snapshotAt).toISOString()}`;
}
