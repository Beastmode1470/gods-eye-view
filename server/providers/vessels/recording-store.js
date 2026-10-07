import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const RECORDING_MAX_ROWS = 50_000;
export const RECORDING_MAX_TRACK_POINTS = 400;
export const RECORDING_MAX_POLLS = 10_000;

export function validUtc(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim().replace(' +0000 UTC', 'Z').replace(' UTC', 'Z');
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function boundedInteger(value, fallback, min, max) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

function finite(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function normalizedVessel(row) {
  const mmsi = String(row?.mmsi ?? '').trim();
  const lat = finite(row?.lat, -90, 90);
  const lon = finite(row?.lon, -180, 180);
  const observedAt = validUtc(row?.observed_at ?? row?.last_position_UTC);
  if (!/^\d{1,10}$/.test(mmsi) || lat === null || lon === null || !observedAt)
    return null;
  const numberOrNull = (v) => finite(v, -1_000_000, 1_000_000);
  return {
    mmsi,
    lat,
    lon,
    observed_at: observedAt,
    name: String(row.name ?? '').slice(0, 200),
    type: String(row.type ?? row.ship_category ?? '').slice(0, 120),
    destination: String(row.destination ?? '').slice(0, 200),
    imo: String(row.imo ?? '').slice(0, 20),
    speed: finite(row.speed, 0, 200),
    course: finite(row.course, 0, 360),
    heading: finite(row.heading ?? row.hdg, 0, 360),
    flag: String(row.flag ?? '').slice(0, 80),
    zone: String(row.zone ?? '').slice(0, 80),
    draught: numberOrNull(row.draught),
    dwt: numberOrNull(row.dwt),
    length: numberOrNull(row.length),
    width: numberOrNull(row.width),
  };
}

export class RecordingLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecordingLimitError';
    this.statusCode = 413;
  }
}

function acquireWriterLock(dbPath) {
  const lockPath = `${dbPath}.writer.lock`;
  const token = randomUUID();
  let fd;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        hostname: process.env.COMPUTERNAME || process.env.HOSTNAME || '',
        startedAt: new Date().toISOString(),
        token,
      }),
      'utf8',
    );
    closeSync(fd);
    fd = undefined;
  } catch (cause) {
    const createdLock = fd !== undefined;
    if (createdLock) closeSync(fd);
    if (cause?.code !== 'EEXIST') {
      if (createdLock) {
        try {
          unlinkSync(lockPath);
        } catch (cleanupError) {
          if (cleanupError?.code !== 'ENOENT') throw cleanupError;
        }
      }
      throw cause;
    }
    let owner = '';
    try {
      const metadata = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (Number.isSafeInteger(metadata.pid))
        owner = ` (PID ${metadata.pid}${metadata.hostname ? ` on ${metadata.hostname}` : ''})`;
    } catch {}
    const error = new Error(
      `Recording database already has a writer${owner}: ${lockPath}. Stop the other collector/viewer first. If it crashed, confirm its process is gone, then remove this stale lock file.`,
    );
    error.code = 'ERR_RECORDING_WRITER_LOCKED';
    error.lockPath = lockPath;
    throw error;
  }

  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        const metadata = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (metadata.token === token) unlinkSync(lockPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
  };
}

/** SQLite-backed immutable collection frames and observed vessel positions. */
export function createRecordingStore({ dbPath, source }) {
  if (typeof dbPath !== 'string' || !dbPath.trim())
    throw new Error('dbPath is required');
  if (!['hormuz', 'aisstream'].includes(source))
    throw new Error('Recording source must be hormuz or aisstream');
  const resolvedDbPath = path.resolve(dbPath);
  mkdirSync(path.dirname(resolvedDbPath), { recursive: true });
  if (existsSync(resolvedDbPath)) {
    const existing = new DatabaseSync(resolvedDbPath, { readOnly: true });
    try {
      const schema = existing
        .prepare(
          "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='recording_config'",
        )
        .get();
      if (!schema) {
        throw new Error(
          'Refusing to modify an existing SQLite database without the AIS recording schema',
        );
      }
      const configuredSource = existing
        .prepare('SELECT source FROM recording_config WHERE singleton=1')
        .get()?.source;
      if (configuredSource && configuredSource !== source) {
        throw new Error(
          `Recording database already belongs to source "${configuredSource}", not "${source}"`,
        );
      }
    } finally {
      existing.close();
    }
  }
  const writerLock = acquireWriterLock(resolvedDbPath);
  let db;
  let insertPoll;
  let findPoll;
  let insertPosition;
  let upsertCrossing;
  try {
    db = new DatabaseSync(resolvedDbPath);
    db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
    );
    db.exec(`
      CREATE TABLE IF NOT EXISTS recording_config (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        source TEXT NOT NULL CHECK (source IN ('hormuz','aisstream'))
      );
      CREATE TABLE IF NOT EXISTS polls (
        poll_id INTEGER PRIMARY KEY AUTOINCREMENT,
        data_stamp TEXT UNIQUE,
        fetched_at TEXT NOT NULL,
        source_last_poll TEXT,
        status TEXT NOT NULL CHECK (status IN ('success','failed')),
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS polls_fetched_at_idx ON polls(fetched_at);
      CREATE INDEX IF NOT EXISTS polls_data_stamp_idx ON polls(data_stamp);
      CREATE TABLE IF NOT EXISTS positions (
        poll_id INTEGER NOT NULL REFERENCES polls(poll_id) ON DELETE CASCADE,
        mmsi TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (poll_id, mmsi, observed_at, lat, lon)
      );
      CREATE INDEX IF NOT EXISTS positions_mmsi_observed_idx ON positions(mmsi, observed_at);
      CREATE INDEX IF NOT EXISTS positions_observed_idx ON positions(observed_at);
      CREATE TABLE IF NOT EXISTS crossings_daily (
        day TEXT NOT NULL,
        direction TEXT NOT NULL,
        count INTEGER NOT NULL CHECK (count >= 0),
        quality TEXT,
        PRIMARY KEY (day, direction)
      );
    `);
    const configured = db
      .prepare('SELECT source FROM recording_config WHERE singleton = 1')
      .get();
    if (configured && configured.source !== source) {
      throw new Error(
        `Recording database already belongs to source "${configured.source}", not "${source}"`,
      );
    }
    if (!configured)
      db.prepare(
        'INSERT INTO recording_config(singleton, source) VALUES (1, ?)',
      ).run(source);

    insertPoll = db.prepare(`
      INSERT INTO polls(data_stamp, fetched_at, source_last_poll, status, error)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(data_stamp) DO UPDATE SET
        fetched_at=excluded.fetched_at,
        source_last_poll=excluded.source_last_poll,
        status=excluded.status,
        error=excluded.error
      WHERE polls.status='failed' OR excluded.status='failed'
    `);
    findPoll = db.prepare('SELECT poll_id FROM polls WHERE data_stamp = ?');
    insertPosition = db.prepare(`
      INSERT OR IGNORE INTO positions(poll_id,mmsi,observed_at,lat,lon,payload)
      VALUES (?,?,?,?,?,?)
    `);
    upsertCrossing = db.prepare(`
      INSERT INTO crossings_daily(day,direction,count,quality) VALUES (?,?,?,?)
      ON CONFLICT(day,direction) DO UPDATE SET count=excluded.count, quality=excluded.quality
    `);
  } catch (error) {
    try {
      db?.close();
    } finally {
      writerLock.release();
    }
    throw error;
  }

  function recordPoll({
    dataStamp = null,
    fetchedAt = new Date().toISOString(),
    sourceLastPoll = null,
    vessels = [],
    crossings = [],
    error = null,
  } = {}) {
    const fetched = validUtc(fetchedAt);
    const stamped = dataStamp === null ? null : validUtc(dataStamp);
    const sourcePolled =
      sourceLastPoll === null ? null : validUtc(sourceLastPoll);
    if (
      !fetched ||
      (dataStamp !== null && !stamped) ||
      (sourceLastPoll !== null && !sourcePolled)
    ) {
      throw new Error('Poll timestamps must be valid UTC timestamps');
    }
    if (!Array.isArray(vessels) || vessels.length > RECORDING_MAX_ROWS) {
      throw new RecordingLimitError(
        `Vessel frame exceeds ${RECORDING_MAX_ROWS} rows`,
      );
    }
    const entries = vessels.map(normalizedVessel).filter(Boolean);
    const daily = [];
    for (const item of crossings) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(item?.day || ''))) continue;
      const parsedDay = new Date(`${item.day}T00:00:00Z`);
      if (
        !Number.isFinite(parsedDay.getTime()) ||
        parsedDay.toISOString().slice(0, 10) !== item.day
      )
        continue;
      const count = Number(item.count);
      const direction = String(item.direction || '').toLowerCase();
      if (
        !Number.isSafeInteger(count) ||
        count < 0 ||
        !['inbound', 'outbound'].includes(direction)
      )
        continue;
      daily.push({
        day: item.day,
        direction,
        count,
        quality: String(item.quality ?? '').slice(0, 120),
      });
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const before = stamped ? findPoll.get(stamped) : null;
      if (
        before &&
        db
          .prepare('SELECT status FROM polls WHERE poll_id=?')
          .get(before.poll_id)?.status === 'success'
      ) {
        db.exec('COMMIT');
        return {
          poll_id: Number(before.poll_id),
          duplicate: true,
          positions: Number(
            db
              .prepare(
                'SELECT COUNT(*) AS count FROM positions WHERE poll_id=?',
              )
              .get(before.poll_id).count,
          ),
        };
      }
      insertPoll.run(
        stamped,
        fetched,
        sourcePolled,
        error ? 'failed' : 'success',
        error ? String(error).slice(0, 500) : null,
      );
      let poll = stamped ? findPoll.get(stamped) : null;
      if (!poll) {
        poll = db.prepare('SELECT last_insert_rowid() AS poll_id').get();
      }
      const pollId = Number(poll.poll_id);
      if (!error) {
        for (const vessel of entries) {
          insertPosition.run(
            pollId,
            vessel.mmsi,
            vessel.observed_at,
            vessel.lat,
            vessel.lon,
            JSON.stringify(vessel),
          );
        }
      }
      for (const crossing of daily)
        upsertCrossing.run(
          crossing.day,
          crossing.direction,
          crossing.count,
          crossing.quality,
        );
      db.exec('COMMIT');
      return {
        poll_id: pollId,
        duplicate: false,
        positions: error ? 0 : entries.length,
      };
    } catch (cause) {
      db.exec('ROLLBACK');
      throw cause;
    }
  }

  function pollsForDay(day, limit = RECORDING_MAX_POLLS) {
    const safeLimit = boundedInteger(
      limit,
      RECORDING_MAX_POLLS,
      1,
      RECORDING_MAX_POLLS,
    );
    const rows = db
      .prepare(
        `
      SELECT poll_id, data_stamp, fetched_at, source_last_poll FROM polls
      WHERE status='success' AND data_stamp >= ? AND data_stamp < ?
      ORDER BY data_stamp, poll_id LIMIT ?
    `,
      )
      .all(
        `${day}T00:00:00.000Z`,
        `${nextDay(day)}T00:00:00.000Z`,
        safeLimit + 1,
      );
    if (rows.length > safeLimit)
      throw new RecordingLimitError(`Poll manifest exceeds ${safeLimit} rows`);
    return rows;
  }

  function snapshot(pollId) {
    const poll = db
      .prepare(
        `SELECT poll_id,data_stamp,fetched_at,source_last_poll FROM polls WHERE poll_id=? AND status='success'`,
      )
      .get(pollId);
    if (!poll) return null;
    const vessels = db
      .prepare(
        'SELECT payload FROM positions WHERE poll_id=? ORDER BY mmsi LIMIT ?',
      )
      .all(pollId, RECORDING_MAX_ROWS)
      .map((row) => JSON.parse(row.payload));
    return { poll, vessels };
  }

  function latestSnapshot() {
    const poll = db
      .prepare(
        `
      SELECT poll_id,data_stamp,fetched_at,source_last_poll FROM polls
      WHERE status='success' ORDER BY fetched_at DESC,poll_id DESC LIMIT 1
    `,
      )
      .get();
    return poll ? snapshot(Number(poll.poll_id)) : null;
  }

  function track(mmsi, before, limit = RECORDING_MAX_TRACK_POINTS) {
    const safeLimit = boundedInteger(
      limit,
      RECORDING_MAX_TRACK_POINTS,
      1,
      RECORDING_MAX_TRACK_POINTS,
    );
    const rows = db
      .prepare(
        `
      SELECT DISTINCT observed_at,lat,lon FROM positions
      WHERE mmsi=? AND observed_at <= ?
      ORDER BY observed_at DESC LIMIT ?
    `,
      )
      .all(mmsi, before, safeLimit)
      .reverse();
    return rows.map((row) => ({
      lat: row.lat,
      lon: row.lon,
      epochSec: Math.floor(Date.parse(row.observed_at) / 1000),
    }));
  }

  function history({ start, end }) {
    const last = end || new Date().toISOString().slice(0, 10);
    const first = start || '2019-01-01';
    const crossings = db
      .prepare(
        `
      SELECT day,direction,count,quality FROM crossings_daily
      WHERE day >= ? AND day <= ? ORDER BY day,direction
    `,
      )
      .all(first, last);
    const coverage = db
      .prepare(
        `
      SELECT MIN(observed_at) AS first_observed_at, MAX(observed_at) AS last_observed_at, COUNT(*) AS positions
      FROM positions WHERE observed_at >= ? AND observed_at < ?
    `,
      )
      .get(`${first}T00:00:00.000Z`, `${nextDay(last)}T00:00:00.000Z`);
    const sourcePolls = db
      .prepare(
        `
      SELECT COUNT(*) AS total, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS successful,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      MIN(fetched_at) AS first_collected_at, MAX(fetched_at) AS last_collected_at
      FROM polls WHERE fetched_at >= ? AND fetched_at < ?
    `,
      )
      .get(`${first}T00:00:00.000Z`, `${nextDay(last)}T00:00:00.000Z`);
    return {
      portwatch: [],
      crossings_daily: crossings,
      recorded_ais: {
        first_observed_at: coverage.first_observed_at,
        last_observed_at: coverage.last_observed_at,
        positions: Number(coverage.positions || 0),
      },
      sources: {
        recorded_ais: { source, ...sourcePolls },
        crossings_daily: {
          source: 'hormuz.data-tracking.net',
          observations: crossings.length,
        },
        portwatch: { source: 'IMF PortWatch', observations: 0 },
      },
      recordingSource: source,
    };
  }

  function stats() {
    const latest =
      db
        .prepare(
          `
      SELECT poll_id,status,error,fetched_at FROM polls
      ORDER BY fetched_at DESC,poll_id DESC LIMIT 1
    `,
        )
        .get() || null;
    const polls = db
      .prepare(
        `
      SELECT COUNT(*) AS total, SUM(status='success') AS successful, SUM(status='failed') AS failed,
      MIN(fetched_at) AS first_collected_at, MAX(fetched_at) AS last_collected_at
      FROM polls
    `,
      )
      .get();
    const positions = db
      .prepare(
        'SELECT COUNT(*) AS count, MIN(observed_at) AS first_observed_at, MAX(observed_at) AS last_observed_at FROM positions',
      )
      .get();
    return {
      collection: {
        source,
        polls: Number(polls.total || 0),
        successful_polls: Number(polls.successful || 0),
        failed_polls: Number(polls.failed || 0),
        positions: Number(positions.count || 0),
        first_collected_at: polls.first_collected_at,
        last_collected_at: polls.last_collected_at,
        latest_poll: latest,
        first_observed_at: positions.first_observed_at,
        last_observed_at: positions.last_observed_at,
      },
      crossings_daily: [],
      prices: [],
      portwatch: [],
    };
  }

  return {
    source,
    dbPath: resolvedDbPath,
    recordPoll,
    pollsForDay,
    snapshot,
    latestSnapshot,
    track,
    history,
    stats,
    close() {
      try {
        db.close();
      } finally {
        writerLock.release();
      }
    },
  };
}

function nextDay(day) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
