const DEFAULT_LONGITUDE_STEP = 5;
const DEFAULT_MIN_ABS_LATITUDE = 45;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Parse NOAA timestamps as UTC even when the source omits the trailing Z. */
export function parseNoaaTime(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const normalized = raw.replace(' ', 'T');
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const timeMs = Date.parse(zoned);
  return Number.isFinite(timeMs) ? timeMs : null;
}

function latestValidRecord(rows, timeKey, valueKeys) {
  if (!Array.isArray(rows)) return null;
  let latest = null;
  for (const row of rows) {
    const observedAtMs = parseNoaaTime(row?.[timeKey]);
    if (observedAtMs === null) continue;
    const values = Object.fromEntries(
      valueKeys.map((key) => [key, finiteNumber(row?.[key])]),
    );
    if (Object.values(values).every((value) => value === null)) continue;
    if (!latest || observedAtMs > latest.observedAtMs) {
      latest = { observedAtMs, ...values };
    }
  }
  return latest;
}

export function normalizeSolarWind(payload) {
  const latest = latestValidRecord(payload, 'time_tag', ['proton_speed']);
  if (!latest) return null;
  return {
    observedAtMs: latest.observedAtMs,
    speedKmS: latest.proton_speed,
  };
}

export function normalizeMagneticField(payload) {
  const latest = latestValidRecord(payload, 'time_tag', ['bt', 'bz_gsm']);
  if (!latest) return null;
  return {
    observedAtMs: latest.observedAtMs,
    totalNt: latest.bt,
    bzGsmNt: latest.bz_gsm,
  };
}

export function normalizePlanetaryK(payload) {
  const latest = latestValidRecord(payload, 'time_tag', ['Kp', 'a_running', 'station_count']);
  if (!latest) return null;
  return {
    observedAtMs: latest.observedAtMs,
    kp: latest.Kp,
    aRunning: latest.a_running,
    stationCount: latest.station_count,
  };
}

function canonicalLongitude(longitude) {
  const wrapped = ((longitude % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

function normalizeAuroraPoint(raw) {
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const longitude = finiteNumber(raw[0]);
  const latitude = finiteNumber(raw[1]);
  const probability = finiteNumber(raw[2]);
  if (longitude === null || latitude === null || probability === null) return null;
  if (latitude < -90 || latitude > 90) return null;
  return {
    longitude: ((longitude % 360) + 360) % 360,
    latitude,
    probability: Math.max(0, Math.min(100, probability)),
  };
}

/**
 * Compress NOAA's 65k-cell OVATION grid into one peak point per longitude
 * bucket and hemisphere. The globe gets a readable oval instead of a carpet.
 */
export function normalizeAuroraGrid(payload, {
  longitudeStep = DEFAULT_LONGITUDE_STEP,
  minAbsLatitude = DEFAULT_MIN_ABS_LATITUDE,
} = {}) {
  const step = Number.isFinite(longitudeStep)
    ? Math.max(1, Math.min(30, Math.round(longitudeStep)))
    : DEFAULT_LONGITUDE_STEP;
  const latitudeFloor = Number.isFinite(minAbsLatitude)
    ? Math.max(0, Math.min(89, minAbsLatitude))
    : DEFAULT_MIN_ABS_LATITUDE;
  const peaks = new Map();

  for (const raw of payload?.coordinates || []) {
    const point = normalizeAuroraPoint(raw);
    if (!point || Math.abs(point.latitude) < latitudeFloor) continue;
    const bucketLongitude = Math.floor(point.longitude / step) * step;
    const hemisphere = point.latitude >= 0 ? 'north' : 'south';
    const key = `${hemisphere}:${bucketLongitude}`;
    const current = peaks.get(key);
    if (!current || point.probability > current.probability) {
      peaks.set(key, {
        longitude: canonicalLongitude(bucketLongitude),
        sourceLongitude: bucketLongitude,
        latitude: point.latitude,
        probability: point.probability,
      });
    }
  }

  const byHemisphere = (hemisphere) => [...peaks.entries()]
    .filter(([key]) => key.startsWith(`${hemisphere}:`))
    .map(([, point]) => point)
    .sort((a, b) => a.sourceLongitude - b.sourceLongitude);

  const north = byHemisphere('north');
  const south = byHemisphere('south');
  if (!north.length && !south.length) return null;
  return {
    observedAtMs: parseNoaaTime(payload?.['Observation Time']),
    forecastAtMs: parseNoaaTime(payload?.['Forecast Time']),
    north,
    south,
    maxProbability: Math.max(0, ...north.map((point) => point.probability), ...south.map((point) => point.probability)),
  };
}

export function latestSpaceWeatherObservation(snapshot) {
  const times = [
    snapshot?.wind?.observedAtMs,
    snapshot?.magneticField?.observedAtMs,
    snapshot?.planetaryK?.observedAtMs,
    snapshot?.aurora?.observedAtMs,
  ].filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

export function formatSpaceWeatherReadout(snapshot) {
  const parts = [];
  const kp = snapshot?.planetaryK?.kp;
  const speed = snapshot?.wind?.speedKmS;
  const bz = snapshot?.magneticField?.bzGsmNt;
  if (Number.isFinite(kp)) parts.push(`Kp ${kp.toFixed(1)}`);
  if (Number.isFinite(speed)) parts.push(`wind ${Math.round(speed)} km/s`);
  if (Number.isFinite(bz)) parts.push(`Bz ${bz >= 0 ? '+' : ''}${bz.toFixed(1)} nT`);
  return parts.join(' · ');
}
