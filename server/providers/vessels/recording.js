import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitSameSite } from '../common/same-site.js';
import {
  createRecordingStore,
  RECORDING_MAX_POLLS,
  RECORDING_MAX_ROWS,
  validUtc,
} from './recording-store.js';
import {
  readAisLiveRecordingSnapshot,
  startAisLiveRecording,
  stopAisLiveRecording,
} from './ais-live.js';
import { newestAisPositionAt } from './ais-store.js';

const HORMUZ_BASE = 'https://hormuz.data-tracking.net';
const DEFAULT_DB = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../.gev-cache/ais-history.sqlite',
);
const HORMUZ_CENTER = Object.freeze({ lon: 56.4, lat: 26.6, height: 240000 });
const MAX_UPSTREAM_BYTES = 6 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function errorBody(error) {
  return { error: error?.message || 'Recording backend error' };
}

function dayValue(value, name, required = false) {
  if (!value && !required) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')))
    throw Object.assign(new Error(`${name} must be YYYY-MM-DD`), {
      statusCode: 400,
    });
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw Object.assign(new Error(`${name} is not a valid calendar date`), {
      statusCode: 400,
    });
  }
  return value;
}

function numberQuery(value, name, min, max, fallback) {
  if (value === null || value === '') return fallback;
  if (!/^\d+$/.test(value))
    throw Object.assign(
      new Error(`${name} must be an integer from ${min} to ${max}`),
      { statusCode: 400 },
    );
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw Object.assign(
      new Error(`${name} must be an integer from ${min} to ${max}`),
      { statusCode: 400 },
    );
  }
  return number;
}

function envValue(env, key, fallback = '') {
  return String(env?.[key] ?? fallback);
}

function resolveSource(source, env) {
  const value = String(source ?? envValue(env, 'AIS_RECORDING_SOURCE'))
    .trim()
    .toLowerCase();
  if (!value) return '';
  if (value !== 'hormuz' && value !== 'aisstream')
    throw new Error('AIS_RECORDING_SOURCE must be blank, hormuz, or aisstream');
  return value;
}

function resolveInterval(source, env) {
  const defaultSeconds = source === 'hormuz' ? 900 : 60;
  const raw = envValue(
    env,
    'AIS_RECORDING_INTERVAL_SECONDS',
    String(defaultSeconds),
  ).trim();
  if (!raw) return defaultSeconds * 1000;
  if (!/^\d+$/.test(raw))
    throw new Error('AIS_RECORDING_INTERVAL_SECONDS must be an integer');
  const seconds = Number(raw);
  if (seconds < (source === 'hormuz' ? 600 : 10) || seconds > 86_400) {
    throw new Error(
      `AIS_RECORDING_INTERVAL_SECONDS must be ${source === 'hormuz' ? 'at least 600' : 'at least 10'} and no more than 86400`,
    );
  }
  return seconds * 1000;
}

async function readJsonLimited(response) {
  if (!response.ok || response.redirected)
    throw new Error(
      `Hormuz upstream unavailable or invalid (HTTP ${response.status})`,
    );
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_UPSTREAM_BYTES)
    throw new Error('Hormuz upstream response exceeds size limit');
  if (!response.body) throw new Error('Hormuz upstream response has no body');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_UPSTREAM_BYTES) {
      await response.body.cancel().catch(() => {});
      throw new Error('Hormuz upstream response exceeds size limit');
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Hormuz upstream returned invalid JSON');
  }
}

async function fetchHormuzJson(fetchImpl, route) {
  const url = new URL(route, HORMUZ_BASE);
  if (
    url.origin !== HORMUZ_BASE ||
    !['/api/summary', '/api/ships', '/api/crossings/daily'].includes(
      url.pathname,
    )
  ) {
    throw new Error('Invalid Hormuz upstream route');
  }
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'error',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  return readJsonLimited(response);
}

function arrayAt(payload, ...paths) {
  if (Array.isArray(payload)) return payload;
  for (const pathValue of paths) {
    let current = payload;
    for (const key of pathValue.split('.')) current = current?.[key];
    if (Array.isArray(current)) return current;
  }
  return null;
}

function hormuzShips(payload) {
  const vessels = arrayAt(
    payload,
    'vessels',
    'ships',
    'data.vessels',
    'data.ships',
  );
  if (!vessels)
    throw new Error('Hormuz ships response did not contain a vessel array');
  return vessels.map((row) => ({
    ...row,
    observed_at: row.observed_at ?? row.position_time ?? row.timestamp,
  }));
}

function hormuzCrossings(payload) {
  const rows = arrayAt(
    payload,
    'crossings_daily',
    'crossings',
    'data.crossings_daily',
    'data',
  );
  if (!rows)
    throw new Error('Hormuz crossings response did not contain a daily array');
  return rows.map((row) => ({
    day: row.day ?? row.date ?? row.crossing_date,
    direction: row.direction ?? row.direction_name,
    count: row.count ?? row.vessel_count ?? row.crossings,
    quality: row.quality ?? row.status ?? '',
  }));
}

function sourceLastPoll(summary) {
  return (
    summary?.source_last_poll ??
    summary?.last_poll ??
    summary?.last_updated ??
    null
  );
}

function frameFromAis(snapshot) {
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  const vessels = rows
    .map((row) => ({
      ...row,
      observed_at: row.last_position_UTC,
    }))
    .filter((row) => validUtc(row.observed_at));
  const newest = newestAisPositionAt(vessels);
  return { vessels, dataStamp: validUtc(newest) };
}

function loopbackRequest(req) {
  const remote = String(req.socket?.remoteAddress || '').replace(
    /^::ffff:/i,
    '',
  );
  if (!['127.0.0.1', '::1'].includes(remote)) return false;
  const host = String(req.headers?.host || '').toLowerCase();
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.split(':')[0];
  return ['127.0.0.1', 'localhost', '::1'].includes(hostname);
}

function normalizeRows(vessels, poll, source) {
  const dataStamp = poll?.data_stamp || poll?.source_last_poll || null;
  const snapshotAt = validUtc(dataStamp);
  const rows = vessels.map((vessel) => {
    const observedAt = validUtc(vessel.observed_at);
    return {
      ...vessel,
      last_position_UTC: observedAt,
      last_position_epoch: observedAt
        ? Math.floor(Date.parse(observedAt) / 1000)
        : null,
      recorded: true,
      source:
        source === 'hormuz'
          ? 'Hormuz local recorded snapshots'
          : 'AISStream local recorded snapshots',
    };
  });
  return {
    rows,
    source:
      source === 'hormuz'
        ? 'Hormuz local recorded snapshots'
        : 'AISStream local recorded snapshots',
    recorded: true,
    status: 'recorded',
    snapshotAt: snapshotAt ? Date.parse(snapshotAt) : null,
    collectedAt: validUtc(poll?.fetched_at)
      ? Date.parse(poll.fetched_at)
      : null,
    newestPositionAt: snapshotAt ? Date.parse(snapshotAt) : null,
    lastMessageAt: snapshotAt ? Date.parse(snapshotAt) : null,
    refreshing: false,
  };
}

export function createRecordingController({
  source: requestedSource,
  dbPath,
  env = process.env,
  fetchImpl = globalThis.fetch,
  stopAisSource = true,
  aisSource = {
    start: startAisLiveRecording,
    read: readAisLiveRecordingSnapshot,
    stop: stopAisLiveRecording,
  },
} = {}) {
  const source = resolveSource(requestedSource, env);
  if (!source) throw new Error('Recording source is not enabled');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const intervalMs = resolveInterval(source, env);
  const db = path.resolve(
    dbPath || envValue(env, 'AIS_RECORDING_DB', DEFAULT_DB) || DEFAULT_DB,
  );
  mkdirSync(path.dirname(db), { recursive: true });
  const store = createRecordingStore({ dbPath: db, source });
  const prior = store.stats().collection.latest_poll;
  let timer = null;
  let inFlight = null;
  let started = false;
  let closed = false;
  let stopping = null;
  let lastHealth = prior
    ? {
        status: prior.status === 'success' ? 'recorded' : 'error',
        error: prior.error,
        fetchedAt: prior.fetched_at,
        poll_id: prior.poll_id,
      }
    : { status: 'idle', error: null, fetchedAt: null };

  async function recordPoll() {
    if (closed) throw new Error('Recording controller is closed');
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const fetchedAt = new Date().toISOString();
      if (source === 'aisstream') {
        let snapshot;
        try {
          snapshot = aisSource.read();
          const frame = frameFromAis(snapshot);
          if (!frame.dataStamp)
            throw new Error(
              'AISStream cache has no valid timestamped position',
            );
          if (snapshot.status !== 'live' && snapshot.status !== 'connected') {
            throw new Error(
              snapshot.error || `AISStream status is ${snapshot.status}`,
            );
          }
          const saved = store.recordPoll({
            dataStamp: frame.dataStamp,
            fetchedAt,
            sourceLastPoll: snapshot.lastMessageAt
              ? new Date(snapshot.lastMessageAt).toISOString()
              : null,
            vessels: frame.vessels,
          });
          lastHealth = { status: 'live', error: null, fetchedAt, ...saved };
          return saved;
        } catch (error) {
          const failed = store.recordPoll({ fetchedAt, error: error.message });
          lastHealth = {
            status: 'error',
            error: error.message,
            fetchedAt,
            ...failed,
          };
          return failed;
        }
      }

      let summary = {};
      let crossingRows = [];
      let partialError = null;
      try {
        const results = await Promise.allSettled([
          fetchHormuzJson(fetchImpl, '/api/summary'),
          fetchHormuzJson(fetchImpl, '/api/ships'),
          fetchHormuzJson(fetchImpl, '/api/crossings/daily'),
        ]);
        if (results[0].status === 'fulfilled') summary = results[0].value;
        else partialError = results[0].reason;
        if (results[2].status === 'fulfilled') {
          try {
            crossingRows = hormuzCrossings(results[2].value);
          } catch (error) {
            partialError ||= error;
          }
        } else partialError ||= results[2].reason;
        if (results[1].status !== 'fulfilled') throw results[1].reason;
        const shipsPayload = results[1].value;
        const shipsStamp = validUtc(shipsPayload?.data_stamp);
        if (!shipsStamp)
          throw new Error(
            'Hormuz ships response is missing a valid data_stamp',
          );
        const vessels = hormuzShips(shipsPayload);
        const saved = store.recordPoll({
          dataStamp: shipsStamp,
          fetchedAt,
          sourceLastPoll: validUtc(sourceLastPoll(summary)),
          vessels,
          crossings: crossingRows,
        });
        if (partialError) {
          const reason = partialError?.message || String(partialError);
          store.recordPoll({ fetchedAt, error: reason });
          lastHealth = {
            status: 'degraded',
            error: reason,
            fetchedAt,
            ...saved,
          };
        } else {
          lastHealth = { status: 'recorded', error: null, fetchedAt, ...saved };
        }
        return saved;
      } catch (error) {
        const failed = store.recordPoll({
          fetchedAt,
          error: error?.message || String(error),
          crossings: crossingRows,
        });
        lastHealth = {
          status: 'error',
          error: error?.message || String(error),
          fetchedAt,
          ...failed,
        };
        return failed;
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function start() {
    if (closed) throw new Error('Recording controller is closed');
    if (started) return;
    started = true;
    if (source === 'aisstream') aisSource.start();
    recordPoll().catch((error) => {
      lastHealth = {
        status: 'error',
        error: error.message,
        fetchedAt: new Date().toISOString(),
      };
    });
    timer = setInterval(() => {
      recordPoll().catch((error) => {
        lastHealth = {
          status: 'error',
          error: error.message,
          fetchedAt: new Date().toISOString(),
        };
      });
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (stopping) return stopping;
    if (closed) return Promise.resolve();
    closed = true;
    started = false;
    if (timer) clearInterval(timer);
    timer = null;
    if (source === 'aisstream' && stopAisSource) aisSource.stop();
    const pending = inFlight;
    stopping = (async () => {
      if (pending) await pending.catch(() => {});
      store.close();
    })();
    return stopping;
  }

  async function handleRequest(req, res, next) {
    const url = new URL(req.url || '/', 'http://localhost');
    const legacyPath = url.pathname;
    let legacyTrack = false;
    if (url.pathname === '/api/live') url.pathname = '/api/vessels';
    else if (url.pathname === '/api/config')
      url.pathname = '/api/hormuz/config';
    else if (url.pathname === '/api/history')
      url.pathname = '/api/hormuz/history';
    else if (url.pathname === '/api/polls') url.pathname = '/api/hormuz/polls';
    else if (url.pathname === '/api/snapshot')
      url.pathname = '/api/hormuz/snapshot';
    else if (url.pathname === '/api/stats') url.pathname = '/api/hormuz/stats';
    else if (url.pathname === '/api/forecast')
      url.pathname = '/api/hormuz/forecast';
    else if (url.pathname.startsWith('/api/track/')) {
      const mmsi = url.pathname.slice('/api/track/'.length);
      url.pathname = '/api/vessels/track';
      if (/^\d{1,10}$/.test(mmsi)) url.searchParams.set('mmsi', mmsi);
      else url.searchParams.delete('mmsi');
      legacyTrack = true;
    }
    if (
      !url.pathname.startsWith('/api/vessels') &&
      !url.pathname.startsWith('/api/hormuz/')
    ) {
      next?.();
      return;
    }
    if (!loopbackRequest(req) || admitSameSite(req, res)) {
      if (!res.headersSent)
        json(res, 403, {
          error: 'Recorded collection endpoints are loopback-only',
        });
      return;
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      json(res, 405, { error: 'Only GET is allowed' });
      return;
    }
    try {
      if (url.pathname === '/api/hormuz/forecast') {
        json(res, 503, {
          error: 'Forecasting is not available in the local recorder',
        });
        return;
      }
      if (url.pathname === '/api/hormuz/config') {
        if (url.search)
          throw Object.assign(new Error('config takes no query parameters'), {
            statusCode: 400,
          });
        const googleMapsKey = envValue(env, 'GOOGLE_MAPS_API_KEY');
        json(res, 200, {
          cesiumToken: envValue(env, 'CESIUM_ION_TOKEN'),
          googleMapsKey,
          center: source === 'hormuz' ? HORMUZ_CENTER : null,
          ports: [],
          recordingSource: source,
          recordingName:
            source === 'hormuz'
              ? 'Hormuz local recorded snapshots'
              : 'AISStream local recorded snapshots',
        });
        return;
      }
      if (url.pathname === '/api/hormuz/stats') {
        if (url.search)
          throw Object.assign(new Error('stats takes no query parameters'), {
            statusCode: 400,
          });
        json(res, 200, {
          ...store.stats(),
          health: { ...lastHealth },
          recordingSource: source,
        });
        return;
      }
      if (url.pathname === '/api/hormuz/history') {
        for (const key of url.searchParams.keys()) {
          if (key !== 'start' && key !== 'end') {
            throw Object.assign(
              new Error('Unsupported history query parameter'),
              { statusCode: 400 },
            );
          }
        }
        const startDay =
          dayValue(url.searchParams.get('start'), 'start') || '2019-01-01';
        const endDay =
          dayValue(url.searchParams.get('end'), 'end') ||
          new Date().toISOString().slice(0, 10);
        if (startDay > endDay)
          throw Object.assign(new Error('end must be on or after start'), {
            statusCode: 400,
          });
        if (
          Date.parse(`${endDay}T00:00:00Z`) -
            Date.parse(`${startDay}T00:00:00Z`) >
          7_300 * 86_400_000
        ) {
          throw Object.assign(
            new Error('History range cannot exceed 20 years'),
            { statusCode: 400 },
          );
        }
        json(res, 200, store.history({ start: startDay, end: endDay }));
        return;
      }
      if (url.pathname === '/api/hormuz/polls') {
        for (const key of url.searchParams.keys()) {
          if (
            key !== 'day' &&
            !(legacyPath === '/api/polls' && key === 'limit')
          ) {
            throw Object.assign(new Error('Unsupported poll query parameter'), {
              statusCode: 400,
            });
          }
        }
        const day = dayValue(url.searchParams.get('day'), 'day', true);
        const requestedLimit =
          legacyPath === '/api/polls'
            ? numberQuery(
                url.searchParams.get('limit'),
                'limit',
                1,
                RECORDING_MAX_POLLS,
                RECORDING_MAX_POLLS,
              )
            : RECORDING_MAX_POLLS;
        const polls = store.pollsForDay(day, requestedLimit);
        json(res, 200, { polls, recordingSource: source });
        return;
      }
      if (url.pathname === '/api/hormuz/snapshot') {
        for (const key of url.searchParams.keys()) {
          if (key !== 'poll_id') {
            throw Object.assign(
              new Error('Unsupported snapshot query parameter'),
              { statusCode: 400 },
            );
          }
        }
        const pollId = numberQuery(
          url.searchParams.get('poll_id'),
          'poll_id',
          1,
          Number.MAX_SAFE_INTEGER,
          null,
        );
        if (!pollId)
          throw Object.assign(new Error('poll_id is required'), {
            statusCode: 400,
          });
        const frame = store.snapshot(pollId);
        if (!frame) {
          json(res, 404, { error: 'Recorded snapshot not found' });
          return;
        }
        if (legacyPath === '/api/snapshot') {
          json(res, 200, {
            poll: frame.poll,
            vessels: frame.vessels.map((row) => ({
              ...row,
              observed_at: row.observed_at,
            })),
            recordingSource: source,
          });
        } else {
          json(res, 200, normalizeRows(frame.vessels, frame.poll, source));
        }
        return;
      }
      if (url.pathname === '/api/vessels/track') {
        for (const key of url.searchParams.keys()) {
          if (key !== 'mmsi' && key !== 'before' && key !== 'hours') {
            throw Object.assign(
              new Error('Unsupported track query parameter'),
              { statusCode: 400 },
            );
          }
        }
        const mmsi = String(url.searchParams.get('mmsi') || '').trim();
        if (!/^\d{1,10}$/.test(mmsi))
          throw Object.assign(new Error('mmsi query param required'), {
            statusCode: 400,
          });
        const beforeRaw = url.searchParams.get('before');
        const hours = legacyTrack
          ? numberQuery(url.searchParams.get('hours'), 'hours', 1, 8760, 720)
          : null;
        const before = beforeRaw
          ? validUtc(beforeRaw)
          : new Date(
              Date.now() - (legacyTrack ? hours * 3_600_000 : 0),
            ).toISOString();
        if (!before)
          throw Object.assign(new Error('before must be an ISO timestamp'), {
            statusCode: 400,
          });
        const samples = store.track(mmsi, before, 400);
        if (legacyTrack) {
          json(res, 200, {
            mmsi,
            points: samples.map((sample) => ({
              lat: sample.lat,
              lon: sample.lon,
              observed_at: new Date(sample.epochSec * 1000).toISOString(),
            })),
            recorded: true,
            recordingSource: source,
          });
          return;
        }
        json(res, 200, {
          mmsi,
          samples,
          source:
            source === 'hormuz'
              ? 'Hormuz local recorded snapshots'
              : 'AISStream local recorded snapshots',
          recorded: true,
          retainedSec: 720 * 3600,
        });
        return;
      }
      if (url.pathname === '/api/vessels') {
        for (const key of url.searchParams.keys()) {
          if (key !== 'maxRows') {
            throw Object.assign(
              new Error('Unsupported vessel query parameter'),
              { statusCode: 400 },
            );
          }
        }
        const maxRows = numberQuery(
          url.searchParams.get('maxRows'),
          'maxRows',
          1,
          RECORDING_MAX_ROWS,
          RECORDING_MAX_ROWS,
        );
        const recent = store.latestSnapshot();
        const rows = recent?.vessels || [];
        const payload = normalizeRows(
          rows.slice(0, maxRows),
          recent?.poll || null,
          source,
        );
        payload.health = lastHealth;
        payload.status = lastHealth.status;
        payload.error = lastHealth.error;
        payload.newestPositionAt = rows.length
          ? Math.max(
              ...rows
                .map((row) => Date.parse(row.observed_at))
                .filter(Number.isFinite),
            )
          : null;
        const status = ['error', 'degraded'].includes(lastHealth.status)
          ? 503
          : 200;
        if (legacyPath === '/api/live') {
          json(res, status, {
            poll: recent?.poll || null,
            vessels: rows.slice(0, maxRows).map((row) => ({
              ...row,
              observed_at: row.observed_at,
            })),
            recordingSource: source,
            status: lastHealth.status,
            error: lastHealth.error,
          });
        } else {
          json(res, status, payload);
        }
        return;
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      json(res, error.statusCode || 500, errorBody(error));
    }
  }

  return {
    source,
    dbPath: db,
    store,
    recordPoll,
    handleRequest,
    start,
    stop,
    get health() {
      return { ...lastHealth };
    },
  };
}

/** Vite middleware plugin; AISStream plugin and recorder share one socket. */
export function recordedVesselsProxy(options = {}) {
  const source = resolveSource(options.source, options.env || process.env);
  if (!source) return { name: 'recorded-vessels-proxy-disabled' };
  let controller;
  function install(server) {
    controller ||=
      createRecordingController({ ...options, source, stopAisSource: false });
    server.middlewares.use((req, res, next) =>
      controller.handleRequest(req, res, next),
    );
    controller.start();
    server.httpServer?.once('close', () => {
      controller?.stop();
      controller = null;
    });
  }
  return {
    name: 'recorded-vessels-proxy',
    configureServer: install,
    configurePreviewServer: install,
    closeBundle() {
      controller?.stop();
      controller = null;
    },
  };
}
