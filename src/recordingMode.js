/** Name the actual recording source, never infer geography from vessel positions. */
export function recordingTitle(source) {
  const text = String(source || '');
  if (/aisstream/i.test(text)) return 'AISSTREAM RECORDING';
  if (/hormuz/i.test(text)) return 'HORMUZ RECORDED';
  return 'AIS RECORDING (SOURCE UNKNOWN)';
}

export function recordingAttribution(source) {
  const text = String(source || '');
  if (/aisstream/i.test(text))
    return { label: 'AISStream.io', url: 'https://aisstream.io' };
  if (/hormuz/i.test(text))
    return {
      label: 'hormuz.data-tracking.net',
      url: 'https://hormuz.data-tracking.net',
    };
  return null;
}

/** Recording mode keeps observations and viewport captures out of remote AI. */
export function recordingUploadsDisabled(
  mode = import.meta.env?.HORMUZ_RECORDED_MODE,
) {
  return mode === true;
}
