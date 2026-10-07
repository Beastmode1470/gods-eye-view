/** Load only authorized browser-facing map configuration from the local backend. */
export async function loadHormuzMapConfig(fetchImpl = fetch) {
  const response = await fetchImpl('/api/hormuz/config', {
    cache: 'no-store',
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok)
    throw new Error('Local Hormuz map configuration unavailable');
  const config = await response.json();
  if (
    !config ||
    !(typeof config.cesiumToken === 'string' || config.cesiumToken === null) ||
    !(typeof config.googleMapsKey === 'string' || config.googleMapsKey === null)
  ) {
    throw new Error('Invalid local Hormuz map configuration');
  }
  if (config.center != null) {
    const { lon, lat, height } = config.center;
    if (
      ![lon, lat, height].every(Number.isFinite) ||
      Math.abs(lon) > 180 ||
      Math.abs(lat) > 90 ||
      height <= 0
    )
      throw new Error('Invalid recorded source camera center');
  }
  // Global AISStream collection has no implied Hormuz camera or geography.
  if (config.recordingSource === 'aisstream' && config.center != null)
    throw new Error(
      'Global AISStream recording must not specify a Hormuz center',
    );
  return {
    ...config,
    cesiumToken: config.cesiumToken || '',
    googleMapsKey: config.googleMapsKey || '',
  };
}
