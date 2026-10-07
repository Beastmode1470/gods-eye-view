import * as Cesium from 'cesium';
import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from './renderGovernor.js';

const CORRIDOR = [
  [55.7, 26.1],
  [56.15, 26.45],
  [56.6, 26.5],
  [57.05, 26.1],
  [57.45, 25.6],
];
const MAX_SYMBOLS = 300;

export function trafficSymbolCount(total) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(MAX_SYMBOLS, Math.ceil(total));
}

function positionAlongCorridor(fraction, lane = 0) {
  const index = Math.min(
    CORRIDOR.length - 2,
    Math.floor(fraction * (CORRIDOR.length - 1)),
  );
  const t = fraction * (CORRIDOR.length - 1) - index;
  const start = CORRIDOR[index];
  const end = CORRIDOR[index + 1];
  return Cesium.Cartesian3.fromDegrees(
    start[0] + (end[0] - start[0]) * t + lane * 0.015,
    start[1] + (end[1] - start[1]) * t + lane * 0.035,
    500,
  );
}

/** Anonymous schematic symbols never enter the actual vessel layer or picking registry. */
export function createHormuzTrafficIllustration(viewer) {
  const banner = document.createElement('aside');
  banner.id = 'hormuz-traffic-illustration';
  banner.hidden = true;
  banner.setAttribute('aria-label', 'Historical daily traffic illustration');
  document.body.appendChild(banner);
  let entities = [];
  let corridor;
  const started = performance.now();
  const icon =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M16 2L27 26L20 23L16 30L12 23L5 26Z" fill="white"/></svg>',
    );
  function clear() {
    releaseContinuousRender('hormuz-illustration');
    for (const entity of entities) viewer.entities.remove(entity);
    entities = [];
    if (corridor) viewer.entities.remove(corridor);
    corridor = null;
    banner.hidden = true;
    governorRequestRender('hormuz-illustration-clear');
  }
  function show(day, observation) {
    banner.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = 'SIMULATED TRAFFIC FLOW - NOT ACTUAL SHIP TRACKS';
    const summary = document.createElement('div');
    summary.textContent = observation
      ? `${day} | ${observation.source === 'portwatch' ? 'IMF PortWatch' : 'Upstream daily crossings'} | ${
          observation.source === 'portwatch'
            ? `${observation.row.a ?? 'missing'} tankers / ${observation.row.b ?? 'missing'} total ships`
            : `${observation.row.a ?? 'missing'} inbound / ${observation.row.b ?? 'missing'} outbound`
        }`
      : `${day} | No daily traffic observation available. Missing is not zero.`;
    const note = document.createElement('div');
    const portwatch = observation?.source === 'portwatch';
    const firstCount = observation?.row.a;
    const secondCount = observation?.row.b;
    const total = portwatch
      ? secondCount
      : Number.isFinite(firstCount) || Number.isFinite(secondCount)
        ? (firstCount ?? 0) + (secondCount ?? 0)
        : null;
    const count = trafficSymbolCount(total);
    note.textContent = `Daily counts, not simultaneous vessels. ${
      Number.isFinite(total) && total > MAX_SYMBOLS
        ? `${count} representative symbols for ${total} daily ships.`
        : 'One illustrative symbol per daily ship count.'
    } ${portwatch ? 'Amber: tankers; cyan: other ships.' : 'Amber: inbound; cyan: outbound; missing directions remain unknown.'} Positions/motion are simulated, not actual routes or proven attack effects.${
      observation?.row.quality ? ` Quality: ${observation.row.quality}.` : ''
    }`;
    banner.append(heading, summary, note);
    banner.hidden = false;
    if (observation && !corridor) {
      corridor = viewer.entities.add({
        id: 'hormuz-illustration-corridor',
        polyline: {
          positions: CORRIDOR.map(([lon, lat]) =>
            Cesium.Cartesian3.fromDegrees(lon, lat, 500),
          ),
          width: 4,
          material: Cesium.Color.fromCssColorString('#ffbf69').withAlpha(0.6),
        },
      });
    }
    if (!observation && corridor) {
      viewer.entities.remove(corridor);
      corridor = null;
    }
    while (entities.length > count) viewer.entities.remove(entities.pop());
    for (let i = entities.length; i < count; i += 1) {
      const lane = (i % 6) - 2.5;
      const seed = (i * 0.61803398875) % 1;
      entities.push(
        viewer.entities.add({
          id: `hormuz-illustration-symbol-${i}`,
          position: new Cesium.CallbackProperty(() => {
            const phase = seed + (performance.now() - started) / 180000;
            // Alternating schematic directions are deliberately unrelated to vessel direction.
            const fraction = phase % 2 <= 1 ? phase % 2 : 2 - (phase % 2);
            return positionAlongCorridor(fraction, lane);
          }, false),
          billboard: {
            image: icon,
            width: 18,
            height: 30,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    }
    const firstSymbols =
      Number.isFinite(firstCount) && Number.isFinite(total) && total > 0
        ? Math.min(count, Math.round((firstCount / total) * count))
        : null;
    entities.forEach((entity, index) => {
      entity.billboard.color = Cesium.Color.fromCssColorString(
        firstSymbols === null
          ? '#cccccc'
          : index < firstSymbols
            ? '#ffbf69'
            : '#39ffd5',
      );
    });
    if (count) holdContinuousRender('hormuz-illustration');
    else releaseContinuousRender('hormuz-illustration');
    governorRequestRender('hormuz-illustration-show');
  }
  return {
    show,
    clear,
    destroy() {
      clear();
      banner.remove();
    },
  };
}
