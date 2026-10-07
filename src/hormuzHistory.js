import { adaptHormuzSnapshot, recordedEpoch } from './data/hormuzRecorded.js';
import { recordingTitle } from './recordingMode.js';

const HISTORY_PLAYBACK_INTERVAL_MS = 1500;

export function historyPlaybackInterval(speed, recorded = false) {
  const multiplier = Number(speed);
  return [1, 10, 30].includes(multiplier)
    ? Math.max(
        recorded ? 250 : 50,
        Math.round(HISTORY_PLAYBACK_INTERVAL_MS / multiplier),
      )
    : HISTORY_PLAYBACK_INTERVAL_MS;
}

export function historyCursorX(date, series) {
  const first = Date.parse(series[0]?.date);
  const last = Date.parse(series.at(-1)?.date);
  const selected = Date.parse(date);
  if (
    ![first, last, selected].every(Number.isFinite) ||
    selected < first ||
    selected > last
  )
    return null;
  const span = Math.max(86400000, last - first);
  return 5 + ((selected - first) / span) * 350;
}

/** Keep distinct published populations separate; missing days stay missing. */
export function historySeries(payload, source) {
  if (source === 'portwatch')
    return payload.portwatch
      .map((row) => ({
        date: row.date,
        a: row.n_tanker,
        b: row.n_total,
        quality: row.quality,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  const days = new Map();
  for (const row of payload.crossings_daily) {
    const day = days.get(row.day) || { date: row.day, a: null, b: null };
    if (row.direction === 'inbound') day.a = row.count;
    if (row.direction === 'outbound') day.b = row.count;
    days.set(row.day, day);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function dailyTrafficObservation(history, day) {
  const portwatch = historySeries(history, 'portwatch').find(
    (row) => row.date === day,
  );
  if (
    portwatch &&
    (Number.isFinite(portwatch.a) || Number.isFinite(portwatch.b))
  ) {
    return { source: 'portwatch', row: portwatch };
  }
  const crossings = historySeries(history, 'crossings').find(
    (row) => row.date === day,
  );
  return crossings &&
    (Number.isFinite(crossings.a) || Number.isFinite(crossings.b))
    ? { source: 'crossings', row: crossings }
    : null;
}

export function automaticHistorySeries(history) {
  const portwatch = historySeries(history, 'portwatch');
  const crossings = historySeries(history, 'crossings');
  const first = [
    portwatch[0]?.date,
    crossings[0]?.date,
    history.recorded_ais.first_observed_at?.slice(0, 10),
  ]
    .filter(Boolean)
    .sort()[0];
  const last = [
    portwatch.at(-1)?.date,
    crossings.at(-1)?.date,
    history.recorded_ais.last_observed_at?.slice(0, 10),
  ]
    .filter(Boolean)
    .sort()
    .at(-1);
  if (!first || !last) return [];
  const rows = new Map(portwatch.map((row) => [row.date, row]));
  const series = [];
  for (let day = first; day; day = nextRecordedDay(day, last)) {
    series.push(rows.get(day) || { date: day, a: null, b: null });
  }
  return series;
}

/** Group only exact observed timestamps; do not interpolate missing vessels or fixes. */
export function recordedFrames(payload) {
  const frames = new Map();
  for (const track of payload.tracks) {
    for (const point of track.points || []) {
      if (recordedEpoch(point.t) === null) continue;
      const vessels = frames.get(point.t) || [];
      vessels.push({
        ...point,
        mmsi: track.mmsi,
        name: track.name,
        ship_category: track.ship_category,
        dwt: track.dwt,
        observed_at: point.t,
      });
      frames.set(point.t, vessels);
    }
  }
  return [...frames.entries()]
    .sort((a, b) => recordedEpoch(a[0]) - recordedEpoch(b[0]))
    .map(([time, vessels]) => ({
      ...adaptHormuzSnapshot({ vessels, poll: { data_stamp: time } }),
      time,
    }));
}

export function recordedPollFrames(payload) {
  if (!Array.isArray(payload?.polls))
    throw new Error('Invalid recorded snapshot manifest');
  if (payload.truncated === true)
    throw new Error(
      'Incomplete recorded snapshot manifest; replay would skip observed frames',
    );
  return payload.polls
    .map((poll) => {
      const time = poll.data_stamp || poll.source_last_poll || poll.fetched_at;
      if (
        !Number.isSafeInteger(poll.poll_id) ||
        poll.poll_id <= 0 ||
        recordedEpoch(time) === null
      ) {
        throw new Error('Invalid recorded snapshot identifier or timestamp');
      }
      return { pollId: poll.poll_id, time };
    })
    .sort(
      (a, b) =>
        recordedEpoch(a.time) - recordedEpoch(b.time) || a.pollId - b.pollId,
    );
}

/** Next UTC calendar day for continuous replay, or null past the last recorded day. */
export function nextRecordedDay(day, lastDay) {
  const next = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(next.getTime())) return null;
  next.setUTCDate(next.getUTCDate() + 1);
  const value = next.toISOString().slice(0, 10);
  return lastDay && value > lastDay ? null : value;
}

async function readLocal(path, fetchImpl = fetch) {
  const response = await fetchImpl(path, {
    cache: 'no-store',
    signal: AbortSignal.timeout(25000),
  });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(
      payload.detail || payload.error || `History HTTP ${response.status}`,
    );
  return payload;
}

/** Mount a local history scrubber, with aggregate and individual replay kept separate. */
export function initHormuzHistory(
  dataManager,
  layer,
  viewer,
  recordingSource = 'hormuz',
  {
    enabled = import.meta.env?.HORMUZ_RECORDED_MODE,
    fetchImpl = fetch,
    createIllustration,
    scheduleInterval = setInterval,
    cancelInterval = clearInterval,
  } = {},
) {
  if (!enabled) return;
  if (typeof createIllustration !== 'function')
    throw new TypeError('A daily traffic illustration renderer is required');
  const panel = document.createElement('details');
  panel.id = 'hormuz-history';
  const title = recordingTitle(recordingSource);
  panel.innerHTML = `<summary>${title} / HISTORY / REPLAY</summary>
    <div class="hormuz-history-body">
      <label>Source <select id="hormuz-history-source">
        <option value="auto" selected>Automatic: recorded AIS / daily traffic illustration</option>
        <option value="portwatch">IMF PortWatch (daily traffic counts)</option>
        <option value="crossings">Upstream daily crossings (aggregate)</option>
        <option value="recorded">Our recorded AIS (individual fixes)</option>
      </select></label>
      <p id="hormuz-history-disclosure"></p>
      <p id="hormuz-history-coverage"></p>
      <p>Aggregate counts are not positions. Daily values show how observed traffic changed;
      they cannot replay individual ship paths. Missing observations are not zero traffic.
      Sources describe different populations; do not sum them.</p>
      <svg id="hormuz-history-chart" viewBox="0 0 360 100" role="img" aria-label="Historical daily traffic"></svg>
      <div id="hormuz-history-legend"></div>
      <label>Date / playback start <input id="hormuz-history-day" type="date"></label>
      <input id="hormuz-history-scrub" type="range" min="0" max="0" value="0" aria-label="Historical day or exact recorded frame">
      <label id="hormuz-history-frame-label" hidden>Within-day recorded snapshot
        <input id="hormuz-history-frame" type="range" min="0" max="0" value="0" aria-label="Within-day recorded snapshot">
      </label>
      <label id="hormuz-history-speed-label">Playback speed (AIS capped at 4 snapshots/sec; none skipped)
        <select id="hormuz-history-speed" aria-label="Playback speed">
          <option value="1">1 step / 1.5 sec</option>
          <option value="10">10×</option>
          <option value="30">30×</option>
        </select>
      </label>
      <div><button id="hormuz-history-play" type="button">Play</button>
        <button id="hormuz-history-latest" type="button">Latest ships</button>
        <button id="hormuz-history-refresh" type="button">Refresh history</button></div>
      <p id="hormuz-history-readout" role="status">Open or refresh to load history. Daily counts are not individual positions.</p>
    </div>`;
  document.body.appendChild(panel);
  const find = (id) => panel.querySelector(`#hormuz-history-${id}`);
  const source = find('source');
  const date = find('day');
  const scrub = find('scrub');
  const readout = find('readout');
  const play = find('play');
  const speed = find('speed');
  const illustration = createIllustration(viewer);
  const read = (path) => readLocal(path, fetchImpl);
  let history;
  let series = [];
  let frames = [];
  let autoFrameIndex = 0;
  let loading = false;
  let chartCursor;
  let chartCursorPoints = [];
  let token = 0;
  let frameToken = 0;
  let timer;
  let selected = false;
  let advancing = false;
  let playbackRun = 0;
  const dayCache = new Map();
  const snapshotCache = new Map();
  let restoredPollId = null;
  let frameUnavailable = false;
  // Cache recent day payloads so playback can cross midnight without the 5-8 s load gap.
  const fetchDay = (day) => {
    if (!dayCache.has(day)) {
      const pending = read(`/api/hormuz/polls?day=${day}`);
      pending.catch(() => dayCache.delete(day));
      dayCache.set(day, pending);
      while (dayCache.size > 3) dayCache.delete(dayCache.keys().next().value);
    }
    return dayCache.get(day);
  };
  const fetchSnapshot = (frame) => {
    if (!snapshotCache.has(frame.pollId)) {
      const pending = read(`/api/hormuz/snapshot?poll_id=${frame.pollId}`);
      pending.catch(() => snapshotCache.delete(frame.pollId));
      snapshotCache.set(frame.pollId, pending);
      while (snapshotCache.size > 3)
        snapshotCache.delete(snapshotCache.keys().next().value);
    }
    return snapshotCache.get(frame.pollId);
  };
  const prefetchNext = () => {
    const next = nextRecordedDay(date.value, date.max);
    if (next)
      fetchDay(next)
        .then((payload) => {
          const first = recordedPollFrames(payload)[0];
          if (first) return fetchSnapshot(first);
        })
        .catch(() => {});
  };
  // Replay never changes the user's layer toggle; it only swaps the layer's contents.
  const layerOn = () =>
    Boolean(dataManager.layers.get('ais-live-vessels')?.enabled);
  const stop = () => {
    cancelInterval(timer);
    timer = null;
    play.textContent = 'Play';
    advancing = false;
    ++playbackRun;
    ++frameToken;
    layer.finishRecordedMotion?.();
  };
  const fail = (error) => {
    stop();
    loading = false;
    frameUnavailable = frames.length > 0;
    illustration.clear();
    readout.textContent = `History unavailable: ${error.message}`;
    console.warn('[Hormuz history]', error);
  };
  function retimePlayback() {
    if (!timer) return;
    cancelInterval(timer);
    timer = scheduleInterval(
      advancePlayback,
      historyPlaybackInterval(speed.value, frames.length > 0),
    );
  }
  function updateChartCursor(day) {
    if (!chartCursor) return;
    const x = historyCursorX(day, series);
    chartCursor.style.display = x === null ? 'none' : '';
    if (x === null) return;
    chartCursor.setAttribute('x1', String(x));
    chartCursor.setAttribute('x2', String(x));
    const row = series.find((item) => item.date === day);
    const max = Math.max(
      1,
      ...series.flatMap((item) => [item.a, item.b]).filter(Number.isFinite),
    );
    chartCursorPoints.forEach((point, index) => {
      const value = row?.[['a', 'b'][index]];
      point.style.display = Number.isFinite(value) ? '' : 'none';
      if (Number.isFinite(value)) {
        point.setAttribute('cx', String(x));
        point.setAttribute('cy', String(95 - (value / max) * 85));
      }
    });
  }
  const chart = () => {
    const svg = find('chart');
    svg.replaceChildren();
    chartCursor = null;
    chartCursorPoints = [];
    svg.style.display = source.value === 'recorded' ? 'none' : '';
    if (source.value === 'recorded') return;
    const max = Math.max(
      1,
      ...series.flatMap((row) => [row.a, row.b]).filter(Number.isFinite),
    );
    const first = Date.parse(series[0]?.date);
    const span = Math.max(86400000, Date.parse(series.at(-1)?.date) - first);
    for (const [key, color] of [
      ['a', '#39ffd5'],
      ['b', '#ffbf69'],
    ]) {
      // Each daily observation stands alone: no fabricated lines across gaps.
      for (const row of series) {
        if (!Number.isFinite(row[key])) continue;
        const circle = document.createElementNS(
          'http://www.w3.org/2000/svg',
          'circle',
        );
        circle.setAttribute(
          'cx',
          String(5 + ((Date.parse(row.date) - first) / span) * 350),
        );
        circle.setAttribute('cy', String(95 - (row[key] / max) * 85));
        circle.setAttribute('r', '1.5');
        circle.setAttribute('fill', color);
        svg.appendChild(circle);
      }
    }
    chartCursor = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'line',
    );
    chartCursor.setAttribute('y1', '5');
    chartCursor.setAttribute('y2', '95');
    chartCursor.setAttribute('stroke', '#ffffff');
    chartCursor.setAttribute('stroke-opacity', '0.65');
    chartCursor.setAttribute('stroke-width', '1');
    svg.appendChild(chartCursor);
    for (const color of ['#39ffd5', '#ffbf69']) {
      const point = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'circle',
      );
      point.setAttribute('r', '3');
      point.setAttribute('fill', color);
      point.setAttribute('stroke', '#ffffff');
      point.setAttribute('stroke-width', '1');
      svg.appendChild(point);
      chartCursorPoints.push(point);
    }
    svg.setAttribute(
      'aria-label',
      `${source.value !== 'crossings' ? 'IMF PortWatch tankers and total ships' : 'Upstream inbound and outbound crossings'}, ${series[0]?.date || 'no data'} through ${series.at(-1)?.date || 'no data'}, scale 0 to ${max}`,
    );
    updateChartCursor(date.value);
  };
  async function showAutomaticDay(index) {
    const day = series[index]?.date;
    if (!day) return;
    const request = ++token;
    ++frameToken;
    loading = true;
    frames = [];
    autoFrameIndex = 0;
    find('frame-label').hidden = true;
    date.value = day;
    updateChartCursor(day);
    const first = history.recorded_ais.first_observed_at?.slice(0, 10);
    const last = history.recorded_ais.last_observed_at?.slice(0, 10);
    if (first && last && day >= first && day <= last) {
      readout.textContent = `Loading recorded AIS for ${day}...`;
      let payload;
      try {
        payload = await fetchDay(day);
      } catch (error) {
        if (request === token) throw error;
        return;
      }
      if (request !== token || source.value !== 'auto') return;
      const dayFrames = recordedPollFrames(payload);
      if (dayFrames.length) {
        frames = dayFrames;
        find('frame').max = String(frames.length - 1);
        find('frame').value = '0';
        find('frame-label').hidden = false;
        const restored =
          restoredPollId === null
            ? 0
            : frames.findIndex((frame) => frame.pollId === restoredPollId);
        restoredPollId = null;
        if (restored < 0) {
          frameUnavailable = true;
          layer.prepareRecordedHistory();
          readout.textContent = `${day} | Selected recorded snapshot is no longer available; choose a frame.`;
        } else await showRecordedIndex(restored);
        if (request === token) loading = false;
        prefetchNext();
        return;
      }
    }
    const observation = dailyTrafficObservation(history, day);
    layer.prepareRecordedHistory();
    illustration.show(day, observation);
    loading = false;
    retimePlayback();
    const observationLabel =
      observation?.source === 'portwatch'
        ? 'IMF PORTWATCH'
        : 'UPSTREAM DAILY CROSSINGS';
    readout.textContent = observation
      ? `${day} | ${observationLabel} | daily counts illustrated on map; no recorded ship positions.`
      : `${day} | No recorded positions or published daily counts. Missing observations are not zero traffic.`;
  }
  async function showRecordedIndex(index) {
    const entry = frames[index];
    if (!entry) {
      readout.textContent =
        'No individual recorded positions on this date. No ships fabricated.';
      return;
    }
    const request = ++frameToken;
    const dayRequest = token;
    const requestedSource = source.value;
    let frame;
    try {
      frame = await fetchSnapshot(entry);
    } catch (error) {
      if (request === frameToken && dayRequest === token) throw error;
      return;
    }
    if (
      request !== frameToken ||
      dayRequest !== token ||
      source.value !== requestedSource
    )
      return;
    illustration.clear();
    frameUnavailable = false;
    autoFrameIndex = index;
    find('frame').value = String(index);
    if (source.value === 'recorded') scrub.value = String(index);
    if (!layerOn()) {
      layer.prepareRecordedHistory();
      readout.textContent = `${title} | ${entry.time} | layer off: enable the vessel layer to see ships.`;
      return;
    }
    layer.showRecordedFrame(frame, {
      animate: Boolean(timer),
      durationMs: historyPlaybackInterval(speed.value, true) * 0.9,
    });
    retimePlayback();
    const partial = frame.truncated || frame.rows.length > 12000;
    readout.textContent = `${title} | ${entry.time} | snapshot ${index + 1}/${frames.length} | ${Math.min(frame.rows.length, 12000)} observed ships${partial ? ` shown of ${frame.totalRows ?? frame.rows.length} — PARTIAL FRAME; omitted vessels are unknown, not absent` : ''}. Display motion between nearby fixes is interpolated, not an observed route.`;
    if (frames[index + 1]) fetchSnapshot(frames[index + 1]).catch(() => {});
  }
  async function show(index) {
    if (source.value === 'auto') return showAutomaticDay(index);
    if (source.value === 'recorded') return showRecordedIndex(index);
    else {
      layer.prepareRecordedHistory();
      const row = series[index];
      date.value = row?.date || '';
      updateChartCursor(row?.date);
      illustration.show(
        row?.date || date.value,
        row ? { source: source.value, row } : null,
      );
      const label =
        source.value === 'portwatch'
          ? 'IMF PORTWATCH: tankers / total'
          : 'UPSTREAM DAILY CROSSINGS: inbound / outbound';
      const missingValue = 'missing';
      readout.textContent = row
        ? `${label} | ${row.date} | ${row.a ?? missingValue} / ${row.b ?? missingValue}${row.quality ? ` | quality: ${row.quality}` : ''}. Simulated illustration only; no individual ship paths.`
        : 'No published daily observation; not zero traffic.';
    }
  }
  async function loadDay() {
    stop();
    const request = ++token;
    loading = true;
    selected = true;
    frameUnavailable = false;
    // Pause latest requests at selection time, not after the manifest arrives.
    layer.prepareRecordedHistory();
    if (source.value !== 'recorded') {
      frames = [];
      scrub.max = String(Math.max(0, series.length - 1));
      const index = series.findIndex((row) => row.date === date.value);
      scrub.value = String(Math.max(0, index));
      if (index < 0) {
        illustration.show(date.value, null);
        readout.textContent = `${date.value || 'Selected date'} | No observation in this source. Missing observations are not zero traffic.`;
        loading = false;
        return;
      }
      await show(index);
      if (request === token) loading = false;
      return;
    }
    // Drop the previous day's frames so Play/scrub cannot show them while loading.
    frames = [];
    scrub.max = '0';
    scrub.value = '0';
    readout.textContent = `Loading actual recorded fixes for ${date.value}; latest fetching paused.`;
    let payload;
    try {
      payload = await fetchDay(date.value);
    } catch (error) {
      if (request === token) throw error;
      return;
    }
    if (request !== token) return;
    frames = recordedPollFrames(payload);
    scrub.max = String(Math.max(0, frames.length - 1));
    scrub.value = '0';
    if (!frames.length) {
      layer.prepareRecordedHistory();
      illustration.clear();
      loading = false;
      readout.textContent =
        'No individual recorded positions on this date. No ships fabricated.';
      return;
    }
    const restored =
      restoredPollId === null
        ? 0
        : frames.findIndex((frame) => frame.pollId === restoredPollId);
    restoredPollId = null;
    if (restored < 0) {
      frameUnavailable = true;
      layer.prepareRecordedHistory();
      readout.textContent =
        'Selected recorded snapshot is no longer available; choose a frame.';
    } else await show(restored);
    if (request === token) loading = false;
    prefetchNext();
  }

  /** Continue Play into the next recorded day; false when no later day has fixes. */
  async function advanceDay() {
    const request = token;
    const run = playbackRun;
    let day = date.value;
    for (;;) {
      day = nextRecordedDay(day, date.max);
      if (!day) return false;
      readout.textContent = `Loading recorded fixes for ${day}; replay continues.`;
      const payload = await fetchDay(day);
      if (
        request !== token ||
        run !== playbackRun ||
        source.value !== 'recorded'
      )
        return false;
      const next = recordedPollFrames(payload);
      if (!next.length) continue;
      frames = next;
      date.value = day;
      scrub.max = String(frames.length - 1);
      scrub.value = '0';
      await show(0);
      prefetchNext();
      return true;
    }
  }
  function chooseSource() {
    stop();
    ++token;
    illustration.clear();
    find('frame-label').hidden = true;
    series =
      source.value === 'auto'
        ? automaticHistorySeries(history)
        : historySeries(
            history,
            source.value === 'recorded' ? 'crossings' : source.value,
          );
    const coverage = history.recorded_ais;
    date.min =
      source.value === 'recorded'
        ? coverage.first_observed_at?.slice(0, 10) || ''
        : series[0]?.date || '';
    date.max =
      source.value === 'recorded'
        ? coverage.last_observed_at?.slice(0, 10) || ''
        : series.at(-1)?.date || '';
    // Keep the user's chosen date when it is inside the new source's coverage.
    if (!date.value)
      date.value =
        source.value === 'recorded' ? date.max : series.at(-1)?.date || '';
    scrub.max =
      source.value === 'recorded'
        ? '0'
        : String(Math.max(0, series.length - 1));
    scrub.value = scrub.max;
    find('legend').textContent =
      source.value === 'recorded'
        ? 'Every recorded snapshot; display easing is not an observed path. No interpolation across long gaps.'
        : `${date.min || 'none'} to ${date.max || 'none'} | cyan: ${source.value !== 'crossings' ? 'tankers' : 'inbound'} | amber: ${source.value !== 'crossings' ? 'total ships' : 'outbound'} | ${source.value !== 'crossings' ? 'PortWatch chart; missing days remain missing' : 'Reception-dependent directional index'}`;
    chart();
  }
  async function refresh() {
    restoredPollId = selected ? (frames[autoFrameIndex]?.pollId ?? null) : null;
    stop();
    const request = ++token;
    readout.textContent = 'Loading local published history...';
    const payload = await read('/api/hormuz/history?start=2019-01-01');
    if (request !== token) return;
    history = payload;
    const firstCrossing =
      historySeries(history, 'crossings')[0]?.date || 'unavailable';
    find('coverage').textContent =
      `Upstream daily crossings from ${firstCrossing}; IMF PortWatch from ${history.portwatch[0]?.date || 'unavailable'}. Individual AIS: ${history.recorded_ais.first_observed_at || 'none'} to ${history.recorded_ais.last_observed_at || 'none'}. No earlier exact trajectory archive is supplied.`;
    find('disclosure').textContent =
      `Automatic replay plays every recorded snapshot within each day, then continues into the next day; otherwise same-day PortWatch counts, then upstream counts. Recorded display movement between nearby fixes is interpolated, not a verified route. Amber map flow is SIMULATED, not actual ship tracks or proven attack effects. Exact positions begin ${history.recorded_ais.first_observed_at?.slice(0, 10) || 'unavailable'}.`;
    chooseSource();
    if (selected) await loadDay();
    else
      readout.textContent =
        'History loaded. Latest ships remain selected; choose a date to replay individual fixes.';
  }
  panel.addEventListener('toggle', () => {
    if (panel.open && !history) refresh().catch(fail);
  });
  find('refresh').onclick = () => {
    dayCache.clear();
    snapshotCache.clear();
    refresh().catch(fail);
  };
  source.onchange = () => {
    restoredPollId = null;
    if (history) {
      chooseSource();
      loadDay().catch(fail);
    }
  };
  date.onchange = () => {
    restoredPollId = null;
    loadDay().catch(fail);
  };
  speed.onchange = () => {
    retimePlayback();
  };
  scrub.oninput = () => {
    stop();
    selected = true;
    if (!layer.getStats().historyMode) layer.prepareRecordedHistory();
    if (source.value === 'recorded' && !frames.length) return;
    show(Number(scrub.value)).catch(fail);
  };
  find('frame').oninput = () => {
    stop();
    selected = true;
    if (!layer.getStats().historyMode) layer.prepareRecordedHistory();
    if (!loading && source.value === 'auto' && frames.length)
      showRecordedIndex(Number(find('frame').value)).catch(fail);
  };
  function advancePlayback() {
    if (advancing || loading) return;
    const run = playbackRun;
    if (source.value === 'auto' && autoFrameIndex + 1 < frames.length) {
      advancing = true;
      showRecordedIndex(autoFrameIndex + 1)
        .catch((error) => {
          if (run === playbackRun) fail(error);
        })
        .finally(() => {
          if (run === playbackRun) advancing = false;
        });
      return;
    }
    const index = Number(scrub.value) + 1;
    if (index > Number(scrub.max)) {
      if (source.value !== 'recorded') return stop();
      advancing = true;
      advanceDay()
        .then((continued) => {
          if (!continued && timer && run === playbackRun) {
            stop();
            if (source.value === 'recorded')
              readout.textContent += ' End of recorded fixes.';
          }
        })
        .catch((error) => {
          if (run === playbackRun) fail(error);
        })
        .finally(() => {
          if (run === playbackRun) advancing = false;
        });
      return;
    }
    if (source.value !== 'recorded') scrub.value = String(index);
    advancing = true;
    show(index)
      .catch((error) => {
        if (run === playbackRun) fail(error);
      })
      .finally(() => {
        if (run === playbackRun) advancing = false;
      });
  }
  play.onclick = () => {
    if (timer) return stop();
    if (frameUnavailable) {
      readout.textContent =
        'Selected recorded snapshot is unavailable. Choose a frame or refresh before playing.';
      return;
    }
    if (!selected) {
      loadDay()
        .then(() => play.onclick())
        .catch(fail);
      return;
    }
    if (loading || (source.value === 'recorded' && !frames.length)) {
      readout.textContent =
        'Recorded day still loading; press Play once the first frame is shown.';
      return;
    }
    play.textContent = 'Pause';
    const interval = historyPlaybackInterval(speed.value, frames.length > 0);
    timer = scheduleInterval(advancePlayback, interval);
  };
  find('latest').onclick = async () => {
    stop();
    selected = false;
    frameUnavailable = false;
    ++token;
    illustration.clear();
    try {
      if (!layerOn()) {
        await layer.resumeRecordedLatest();
        readout.textContent =
          'Latest ships selected. Enable the vessel layer to see them.';
        return;
      }
      await layer.resumeRecordedLatest();
      readout.textContent =
        layer.getStats().error ||
        'Map: latest recorded AIS snapshot. Historical chart remains separate.';
    } catch (error) {
      fail(error);
    }
  };
  return () => {
    stop();
    ++token;
    illustration.destroy();
    panel.remove();
  };
}
