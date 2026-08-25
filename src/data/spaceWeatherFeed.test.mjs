import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSpaceWeatherReadout,
  latestSpaceWeatherObservation,
  normalizeAuroraGrid,
  normalizeMagneticField,
  normalizePlanetaryK,
  normalizeSolarWind,
  parseNoaaTime,
} from './spaceWeatherFeed.js';

test('NOAA summary normalizers select the newest usable observation', () => {
  const wind = normalizeSolarWind([
    { proton_speed: 410, time_tag: '2026-08-25T01:00:00Z' },
    { proton_speed: 455, time_tag: '2026-08-25T01:05:00Z' },
    { proton_speed: null, time_tag: '2026-08-25T01:06:00Z' },
  ]);
  const magneticField = normalizeMagneticField([
    { bt: 6, bz_gsm: -3, time_tag: '2026-08-25T01:04:00Z' },
  ]);
  const planetaryK = normalizePlanetaryK([
    { time_tag: '2026-08-25T00:00:00', Kp: 2.33, a_running: 9, station_count: 8 },
  ]);

  assert.deepEqual(wind, {
    observedAtMs: Date.parse('2026-08-25T01:05:00Z'),
    speedKmS: 455,
  });
  assert.deepEqual(magneticField, {
    observedAtMs: Date.parse('2026-08-25T01:04:00Z'),
    totalNt: 6,
    bzGsmNt: -3,
  });
  assert.equal(planetaryK.kp, 2.33);
  assert.equal(planetaryK.observedAtMs, Date.parse('2026-08-25T00:00:00Z'));
  assert.equal(parseNoaaTime('not-a-date'), null);
});

test('OVATION compression keeps one strongest point per longitude bucket and hemisphere', () => {
  const aurora = normalizeAuroraGrid({
    'Observation Time': '2026-08-25T01:03:00Z',
    'Forecast Time': '2026-08-25T02:30:00Z',
    coordinates: [
      [0, 65, 12],
      [4, 67, 28],
      [5, 69, 20],
      [355, 64, 16],
      [0, -64, 9],
      [3, -67, 21],
      [5, -70, 18],
      [20, 20, 99],
      ['bad', 70, 50],
    ],
  });

  assert.equal(aurora.north.length, 3);
  assert.equal(aurora.south.length, 2);
  assert.deepEqual(aurora.north[0], {
    longitude: 0,
    sourceLongitude: 0,
    latitude: 67,
    probability: 28,
  });
  assert.equal(aurora.north.at(-1).longitude, -5);
  assert.equal(aurora.maxProbability, 28);
  assert.equal(aurora.observedAtMs, Date.parse('2026-08-25T01:03:00Z'));
});

test('compact readout and observation time use normalized component values', () => {
  const snapshot = {
    wind: { speedKmS: 455, observedAtMs: 3 },
    magneticField: { bzGsmNt: -3, observedAtMs: 2 },
    planetaryK: { kp: 2.33, observedAtMs: 1 },
    aurora: { observedAtMs: 4 },
  };
  assert.equal(formatSpaceWeatherReadout(snapshot), 'Kp 2.3 · wind 455 km/s · Bz -3.0 nT');
  assert.equal(latestSpaceWeatherObservation(snapshot), 4);
});
