import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpaceWeatherLayer } from './spaceWeather.js';

const PAYLOADS = Object.freeze({
  wind: [{ proton_speed: 455, time_tag: '2026-08-25T01:05:00Z' }],
  magneticField: [{ bt: 6, bz_gsm: -3, time_tag: '2026-08-25T01:04:00Z' }],
  planetaryK: [{ time_tag: '2026-08-25T00:00:00', Kp: 2.33, a_running: 9, station_count: 8 }],
  aurora: {
    'Observation Time': '2026-08-25T01:03:00Z',
    'Forecast Time': '2026-08-25T02:30:00Z',
    coordinates: [
      [0, 67, 28], [5, 69, 20], [355, 64, 16],
      [0, -67, 21], [5, -70, 18], [355, -65, 14],
    ],
  },
});

function payloadForUrl(url) {
  if (url.includes('solar-wind-speed')) return PAYLOADS.wind;
  if (url.includes('solar-wind-mag-field')) return PAYLOADS.magneticField;
  if (url.includes('planetary-k-index')) return PAYLOADS.planetaryK;
  if (url.includes('ovation_aurora')) return PAYLOADS.aurora;
  throw new Error(`unexpected URL ${url}`);
}

function fakeViewer() {
  const values = [];
  return {
    values,
    viewer: {
      dataSources: {
        add(dataSource) { values.push(dataSource); return dataSource; },
        remove(dataSource) {
          const index = values.indexOf(dataSource);
          if (index >= 0) values.splice(index, 1);
          return index >= 0;
        },
      },
    },
  };
}

test('space-weather layer renders compressed static ovals and a compact current readout', async () => {
  const fetchImpl = async (url) => ({ ok: true, json: async () => payloadForUrl(url) });
  const { viewer, values } = fakeViewer();
  const layer = createSpaceWeatherLayer({ fetchImpl });

  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(values[0].show, true);
  assert.equal(await layer.update(viewer), true);

  const entities = values[0].entities.values;
  assert.equal(entities.length, 8, 'two oval lines plus six peak points');
  assert.ok(entities.every((entity) => entity.point || entity.polyline));
  assert.ok(entities.every((entity) => entity.position?.isConstant !== false));

  const stats = layer.getStats();
  assert.equal(stats.count, 6);
  assert.equal(stats.status, 'nominal');
  assert.equal(stats.loadingLabel, 'Kp 2.3 · wind 455 km/s · Bz -3.0 nT');
  assert.equal(stats.error, null);

  layer.disable(viewer);
  assert.equal(values[0].show, false);
  layer.destroy(viewer);
  assert.equal(values.length, 0);
});

test('a total feed outage preserves the last good visual and reports stale', async () => {
  let failing = false;
  const fetchImpl = async (url) => {
    if (failing) throw new Error('offline');
    return { ok: true, json: async () => payloadForUrl(url) };
  };
  const { viewer, values } = fakeViewer();
  const layer = createSpaceWeatherLayer({ fetchImpl });
  layer.init(viewer);
  layer.enable(viewer);
  await layer.update(viewer);
  const before = values[0].entities.values.length;

  failing = true;
  assert.equal(await layer.update(viewer), false);
  assert.equal(values[0].entities.values.length, before);
  assert.equal(layer.getStats().status, 'stale');
  assert.match(layer.getStats().error, /wind offline/);
  layer.destroy(viewer);
});
