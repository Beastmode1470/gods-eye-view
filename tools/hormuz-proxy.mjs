import {
  adaptHormuzSnapshot,
  adaptHormuzTrack,
  recordedEpoch,
  HORMUZ_MAX_ROWS,
} from '../src/data/hormuzRecorded.js';

function validDay(value) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value || '') &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

/** Accept only explicit loopback HTTP origins, never credentials or remote hosts. */
export function resolveHormuzUrl(value) {
  if (!value?.trim()) return null;
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'HORMUZ_API_URL must be a loopback HTTP origin, e.g. http://127.0.0.1:8808',
    );
  }
  return url.origin;
}

function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

/** Local-only Hormuz read adapter with no arbitrary URL or unrelated business endpoints. */
export function createHormuzMiddleware(origin, fetchImpl = fetch) {
  origin = resolveHormuzUrl(origin);
  if (!origin) throw new Error('Hormuz origin required');
  let normalizedApi = false;
  let recordingSource = 'hormuz';
  return async (req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/setup/keys') {
      return reply(res, 403, {
        error:
          'Hormuz mode uses existing backend map credentials. Provider saves here do not change them; no key input is needed.',
      });
    }
    if (/^\/api\/(openai|realtime)(\/|$)/.test(url.pathname)) {
      reply(res, 403, {
        error:
          'External context/AI requests disabled in local Hormuz recorded mode',
      });
      return;
    }
    const context = [
      '/api/hormuz/config',
      '/api/hormuz/forecast',
      '/api/hormuz/stats',
      '/api/hormuz/history',
      '/api/hormuz/replay',
      '/api/hormuz/polls',
      '/api/hormuz/snapshot',
    ].includes(url.pathname);
    if (
      !context &&
      url.pathname !== '/api/vessels' &&
      !url.pathname.startsWith('/api/vessels/') &&
      !url.pathname.startsWith('/api/hormuz/')
    )
      return next();
    const peer = req.socket?.remoteAddress;
    if (peer && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) {
      return reply(res, 403, { error: 'Hormuz data is local-only' });
    }
    if (
      Object.keys(req.headers || {}).some(
        (key) =>
          key.toLowerCase() === 'forwarded' ||
          key.toLowerCase().startsWith('x-forwarded-'),
      )
    ) {
      return reply(res, 403, {
        error: 'Forwarded recorded-data access denied',
      });
    }
    let localHost = false;
    try {
      localHost = ['localhost', '127.0.0.1', '[::1]'].includes(
        new URL(`http://${req.headers?.host}`).hostname,
      );
    } catch {
      // An invalid Host is never a local recording origin.
    }
    if (!localHost)
      return reply(res, 403, { error: 'Loopback recording Host required' });
    if (req.headers?.origin) {
      let localOrigin = false;
      try {
        const requestOrigin = new URL(req.headers.origin);
        localOrigin = requestOrigin.origin === `http://${req.headers.host}`;
      } catch {
        /* malformed Origin is rejected */
      }
      if (!localOrigin)
        return reply(res, 403, { error: 'Cross-origin Hormuz access denied' });
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      reply(res, 405, { error: 'Read-only Hormuz source' });
      return;
    }
    if (url.pathname === '/api/hormuz/forecast') {
      return reply(res, 503, {
        error: 'No forecast model is supplied by this public recording viewer',
      });
    }
    let route;
    let mmsi;
    let before = Infinity;
    if (url.pathname === '/api/hormuz/config') {
      if (url.search)
        return reply(res, 400, {
          error: 'Map configuration takes no parameters',
        });
      route = '/api/config';
    } else if (url.pathname === '/api/hormuz/history') {
      if (
        [...url.searchParams.keys()].some(
          (key) => !['start', 'end'].includes(key),
        )
      ) {
        return reply(res, 400, { error: 'Unsupported history parameters' });
      }
      const start = url.searchParams.get('start') || '2019-01-01';
      const end =
        url.searchParams.get('end') || new Date().toISOString().slice(0, 10);
      if (!validDay(start) || !validDay(end) || start > end)
        return reply(res, 400, {
          error: 'Valid ordered history dates required',
        });
      route = `/api/history?start=${start}&end=${end}`;
    } else if (url.pathname === '/api/hormuz/polls') {
      const day = url.searchParams.get('day');
      if (
        !validDay(day) ||
        [...url.searchParams.keys()].some((key) => key !== 'day')
      ) {
        return reply(res, 400, {
          error: 'One recorded snapshot day (YYYY-MM-DD) required',
        });
      }
      route = `/api/polls?day=${day}&limit=5000`;
    } else if (url.pathname === '/api/hormuz/snapshot') {
      const poll = url.searchParams.get('poll_id');
      if (
        !/^[1-9]\d{0,9}$/.test(poll || '') ||
        [...url.searchParams.keys()].some((key) => key !== 'poll_id')
      ) {
        return reply(res, 400, {
          error: 'One positive recorded poll_id required',
        });
      }
      route = `/api/snapshot?poll_id=${poll}`;
    } else if (url.pathname === '/api/hormuz/replay') {
      const day = url.searchParams.get('day');
      if (
        !validDay(day) ||
        [...url.searchParams.keys()].some((key) => key !== 'day')
      ) {
        return reply(res, 400, {
          error: 'One recorded replay day (YYYY-MM-DD) required',
        });
      }
      // Date prefixes follow the backend's stored local dates; retain original
      // offsets rather than synthesizing UTC-midnight individual positions.
      route = `/api/replay?start=${day}T00%3A00%3A00&end=${day}T23%3A59%3A59.999&limit=20000`;
    } else if (context) {
      if (
        [...url.searchParams.keys()].some((key) => key !== 'target_month') ||
        (url.pathname.endsWith('/stats') && url.search)
      ) {
        return reply(res, 400, {
          error: 'Unsupported Hormuz context parameters',
        });
      }
      const month = url.searchParams.get('target_month');
      if (month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        return reply(res, 400, { error: 'target_month must be YYYY-MM' });
      }
      route = url.pathname.endsWith('/forecast')
        ? '/api/forecast' + (month ? `?target_month=${month}` : '')
        : '/api/stats';
    } else if (url.pathname === '/api/vessels/track') {
      mmsi = url.searchParams.get('mmsi') || '';
      if (!/^\d{1,10}$/.test(mmsi))
        return reply(res, 400, {
          error: 'Valid recorded vessel identifier required',
          samples: [],
        });
      const beforeText = url.searchParams.get('before');
      if (beforeText !== null) {
        before = recordedEpoch(beforeText);
        if (before === null)
          return reply(res, 400, {
            error: 'Valid recorded cutoff required',
            samples: [],
          });
      }
      route = `/api/track/${mmsi}?hours=${beforeText === null ? 720 : 8760}`;
    } else if (url.pathname === '/api/vessels') {
      route = '/api/live';
    } else {
      return reply(res, 404, { error: 'Unknown Hormuz route' });
    }
    try {
      const options = {
        signal: AbortSignal.timeout(
          route.startsWith('/api/forecast') ? 60000 : context ? 20000 : 7000,
        ),
        redirect: 'error',
        headers: { Accept: 'application/json' },
      };
      const normalizedRoute = () => {
        if (route === '/api/live') return '/api/vessels' + url.search;
        if (mmsi) return '/api/vessels/track' + url.search;
        if (route === '/api/config') return '/api/hormuz/config';
        if (route.startsWith('/api/history'))
          return '/api/hormuz/history' + route.slice('/api/history'.length);
        if (route.startsWith('/api/polls'))
          return '/api/hormuz/polls?day=' + url.searchParams.get('day');
        if (route.startsWith('/api/snapshot'))
          return '/api/hormuz/snapshot' + url.search;
        if (route === '/api/stats') return '/api/hormuz/stats';
        return null;
      };
      let upstream = await fetchImpl(
        origin + (normalizedApi ? normalizedRoute() || route : route),
        options,
      );
      // The public CLI exposes only normalized routes. An explicit 404 on a
      // fixed legacy endpoint permits the matching fixed normalized endpoint.
      if (!normalizedApi && upstream.status === 404 && normalizedRoute()) {
        await upstream.body?.cancel();
        upstream = await fetchImpl(origin + normalizedRoute(), options);
        if (upstream.ok) normalizedApi = true;
      }
      if (!upstream.ok && !context)
        throw new Error(`Upstream HTTP ${upstream.status}`);
      const declaredLength = Number(upstream.headers.get('content-length'));
      if (declaredLength > 8 * 1024 * 1024)
        throw new Error('Hormuz response too large');
      const reader = upstream.body.getReader();
      const chunks = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 8 * 1024 * 1024)
            throw new Error('Hormuz response too large');
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel();
      }
      let payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (upstream.ok) {
        if (['hormuz', 'aisstream'].includes(payload?.recordingSource))
          recordingSource = payload.recordingSource;
        if (/aisstream/i.test(String(payload?.source || '')))
          recordingSource = 'aisstream';
      }
      if (normalizedApi && upstream.ok) {
        if (route === '/api/config') {
          payload = {
            ...payload,
            cesiumToken: payload.cesiumToken ?? '',
            googleMapsKey: payload.googleMapsKey ?? '',
          };
        } else if (route === '/api/live' || route.startsWith('/api/snapshot')) {
          if (payload?.recorded !== true || !Array.isArray(payload.rows))
            throw new Error(
              'Invalid or incomplete normalized recording snapshot',
            );
          const snapshotAt = Number.isFinite(payload.snapshotAt)
            ? new Date(payload.snapshotAt).toISOString()
            : null;
          payload = {
            truncated: payload.truncated === true,
            totalRows: payload.totalRows,
            status: payload.status,
            error: payload.error,
            reason: payload.reason,
            refreshing: payload.refreshing,
            newestPositionAt: payload.newestPositionAt,
            lastMessageAt: payload.lastMessageAt,
            vessels: payload.rows.map((row) => ({
              ...row,
              observed_at: row.last_position_UTC,
              ship_category: row.type,
              hdg: row.heading,
            })),
            poll: {
              poll_id: Number(url.searchParams.get('poll_id')),
              data_stamp: snapshotAt,
              fetched_at: Number.isFinite(payload.collectedAt)
                ? new Date(payload.collectedAt).toISOString()
                : null,
            },
          };
        } else if (mmsi) {
          if (payload?.recorded !== true || !Array.isArray(payload.samples))
            throw new Error('Invalid normalized recording track');
          payload = {
            mmsi: payload.mmsi,
            points: payload.samples.map((row) => ({
              lat: row.lat,
              lon: row.lon,
              observed_at: Number.isFinite(row.epochSec)
                ? new Date(row.epochSec * 1000).toISOString()
                : null,
            })),
          };
        } else if (route === '/api/stats') {
          payload = { ...payload, prices: [] };
        }
      }
      if (route === '/api/config') {
        if (payload) {
          payload.cesiumToken ??= '';
          payload.googleMapsKey ??= '';
        }
        if (
          !upstream.ok ||
          !payload ||
          typeof payload.cesiumToken !== 'string' ||
          typeof payload.googleMapsKey !== 'string'
        ) {
          throw new Error(
            'Local Hormuz map configuration unavailable or invalid',
          );
        }
        // These two provider credentials are intentionally browser-facing.
        // Explicit projection prevents unrelated backend configuration leaking.
        const center = payload.center;
        const validCenter =
          center &&
          Number.isFinite(center.lon) &&
          Math.abs(center.lon) <= 180 &&
          Number.isFinite(center.lat) &&
          Math.abs(center.lat) <= 90 &&
          Number.isFinite(center.height) &&
          center.height > 0;
        const ports = Array.isArray(payload.ports)
          ? payload.ports
              .filter(
                (port) =>
                  Number.isFinite(port.lat) &&
                  Math.abs(port.lat) <= 90 &&
                  Number.isFinite(port.lon) &&
                  Math.abs(port.lon) <= 180,
              )
              .slice(0, 100)
              .map((port) => ({
                name: String(port.name || ''),
                lat: port.lat,
                lon: port.lon,
                country: String(port.country || ''),
              }))
          : [];
        return reply(res, 200, {
          cesiumToken: payload.cesiumToken,
          googleMapsKey: payload.googleMapsKey,
          center:
            validCenter && recordingSource !== 'aisstream'
              ? { lon: center.lon, lat: center.lat, height: center.height }
              : null,
          ports,
          recordingSource,
        });
      }
      if (context) {
        if (!upstream.ok) {
          return reply(res, upstream.status, {
            error: 'Local Hormuz context unavailable',
            detail: String(
              payload?.detail ||
                payload?.error ||
                `Upstream HTTP ${upstream.status}`,
            ),
          });
        }
        const valid = route.startsWith('/api/forecast')
          ? 'baseline' in (payload || {}) && payload.scenarios && payload.ais
          : route.startsWith('/api/history')
            ? Array.isArray(payload?.portwatch) &&
              Array.isArray(payload?.crossings_daily) &&
              payload?.recorded_ais &&
              payload?.sources
            : route.startsWith('/api/replay')
              ? Array.isArray(payload?.tracks)
              : route.startsWith('/api/polls')
                ? Array.isArray(payload?.polls)
                : route.startsWith('/api/snapshot')
                  ? payload?.poll && Array.isArray(payload?.vessels)
                  : payload?.collection &&
                    Array.isArray(payload?.crossings_daily) &&
                    Array.isArray(payload?.prices) &&
                    Array.isArray(payload?.portwatch);
        if (
          !payload ||
          typeof payload !== 'object' ||
          Array.isArray(payload) ||
          !valid
        ) {
          throw new Error('Invalid Hormuz context response');
        }
        if (route.startsWith('/api/replay')) {
          const count = payload.tracks.reduce(
            (sum, track) =>
              sum + (Array.isArray(track.points) ? track.points.length : 0),
            0,
          );
          return reply(res, 200, {
            ...payload,
            recorded: true,
            truncated: count >= 20000,
            limit: 20000,
          });
        }
        if (route.startsWith('/api/polls')) {
          if (
            payload.truncated === true ||
            payload.polls.length >= (normalizedApi ? 10000 : 5000)
          )
            throw new Error('Snapshot day manifest exceeds replay limit');
          return reply(res, 200, {
            polls: payload.polls.map((poll) => ({
              poll_id: poll.poll_id,
              data_stamp: poll.data_stamp,
              source_last_poll: poll.source_last_poll,
              fetched_at: poll.fetched_at,
            })),
          });
        }
        if (route.startsWith('/api/snapshot')) {
          if (
            payload.poll.poll_id !== Number(url.searchParams.get('poll_id'))
          ) {
            throw new Error('Recorded snapshot identifier mismatch');
          }
          return reply(res, 200, {
            ...adaptHormuzSnapshot(payload),
            recordingSource,
            source:
              recordingSource === 'aisstream'
                ? 'AISStream local recorded snapshots'
                : 'Hormuz local recorded snapshots',
          });
        }
        if (route.startsWith('/api/history')) {
          return reply(res, 200, {
            portwatch: payload.portwatch,
            crossings_daily: payload.crossings_daily,
            recorded_ais: payload.recorded_ais,
            sources: payload.sources,
            recordingSource,
          });
        }
        return reply(res, 200, {
          collection: payload.collection,
          crossings_daily: payload.crossings_daily,
          portwatch: payload.portwatch,
          recordingSource,
        });
      }
      const requested = Number(url.searchParams.get('maxRows'));
      const maxRows =
        Number.isInteger(requested) && requested > 0
          ? Math.min(requested, HORMUZ_MAX_ROWS)
          : HORMUZ_MAX_ROWS;
      reply(res, 200, {
        ...(mmsi
          ? adaptHormuzTrack(payload, mmsi, before)
          : adaptHormuzSnapshot(payload, maxRows)),
        recordingSource,
        source:
          recordingSource === 'aisstream'
            ? 'AISStream local recorded snapshots'
            : 'Hormuz local recorded snapshots',
      });
    } catch (error) {
      console.warn(
        '[Hormuz proxy]',
        route === '/api/config'
          ? 'Map configuration unavailable or invalid'
          : error.message,
      );
      reply(res, 502, {
        status: 'error',
        error: 'Local Hormuz backend unavailable or invalid',
        rows: [],
        samples: [],
      });
    }
  };
}

/** Install before public proxies in dev and preview; disabled mode is a no-op. */
export function hormuzProxy(origin) {
  const install = (server) => {
    if (origin) server.middlewares.use(createHormuzMiddleware(origin));
  };
  return {
    name: 'local-hormuz-recorded',
    configResolved(config) {
      if (!origin) return;
      for (const options of [config.server, config.preview]) {
        if (!['localhost', '127.0.0.1', '::1'].includes(options.host)) {
          throw new Error(
            'Hormuz recorded mode requires a loopback server binding',
          );
        }
      }
    },
    configureServer: install,
    configurePreviewServer: install,
  };
}
