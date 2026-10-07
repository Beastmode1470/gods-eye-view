/** Display easing only: raw fixes and trail vertices remain recorded observations. */
export function recordedVesselMotion(from, to, durationMs, startedAt) {
  if (!from?.recorded || !to?.recorded || !(durationMs > 0)) return null;
  if (
    ![
      from.lastPositionEpoch,
      to.lastPositionEpoch,
      durationMs,
      startedAt,
    ].every(Number.isFinite)
  )
    return null;
  const gap = to.lastPositionEpoch - from.lastPositionEpoch;
  if (!Number.isFinite(gap) || gap <= 0 || gap > 90 * 60) return null;
  if (![from.lat, from.lon, to.lat, to.lon].every(Number.isFinite)) return null;
  const rad = Math.PI / 180;
  const dlat = (to.lat - from.lat) * rad;
  const dlon = (((to.lon - from.lon + 540) % 360) - 180) * rad;
  const a =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(from.lat * rad) * Math.cos(to.lat * rad) * Math.sin(dlon / 2) ** 2;
  const distanceM = 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
  if (distanceM < 1 || distanceM > gap * 60 * 0.514444 + 100) return null;
  return {
    fromLat: from.lat,
    fromLon: from.lon,
    toLat: to.lat,
    toLon: to.lon,
    deltaLon: dlon / rad,
    durationMs,
    startedAt,
  };
}

export function recordedMotionPoint(motion, now) {
  const fraction = Math.max(
    0,
    Math.min(1, (now - motion.startedAt) / motion.durationMs),
  );
  return {
    lat: motion.fromLat + (motion.toLat - motion.fromLat) * fraction,
    lon: ((motion.fromLon + motion.deltaLon * fraction + 540) % 360) - 180,
    done: fraction === 1,
  };
}
