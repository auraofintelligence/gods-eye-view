import * as Cesium from 'cesium';
import {
  formatSpaceWeatherReadout,
  latestSpaceWeatherObservation,
  normalizeAuroraGrid,
  normalizeMagneticField,
  normalizePlanetaryK,
  normalizeSolarWind,
} from './spaceWeatherFeed.js';

const FEEDS = Object.freeze({
  wind: 'https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json',
  magneticField: 'https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json',
  planetaryK: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
  aurora: 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json',
});

const AURORA_ALTITUDE_M = 110_000;
const STALE_AFTER_MS = 30 * 60 * 1000;

const NORTH_COLOR = Cesium.Color.fromCssColorString('#8DFFB5');
const SOUTH_COLOR = Cesium.Color.fromCssColorString('#55DDE0');

async function fetchJson(fetchImpl, url, parentSignal = null) {
  const timeoutSignal = AbortSignal.timeout(20_000);
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: parentSignal
      ? AbortSignal.any([parentSignal, timeoutSignal])
      : timeoutSignal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function ringPositions(points) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const closed = [...points, points[0]];
  return closed.map((point) => Cesium.Cartesian3.fromDegrees(
    point.longitude,
    point.latitude,
    AURORA_ALTITUDE_M,
  ));
}

function pointStyle(color, probability) {
  const strength = Math.max(0, Math.min(100, Number(probability) || 0));
  return {
    pixelSize: 3 + (strength / 12),
    color: color.withAlpha(0.18 + (strength / 150)),
    outlineColor: Cesium.Color.BLACK.withAlpha(0.35),
    outlineWidth: 1,
  };
}

function addAuroraRing(dataSource, hemisphere, points, color) {
  const positions = ringPositions(points);
  if (positions.length > 2) {
    dataSource.entities.add({
      id: `space-weather:${hemisphere}:oval`,
      polyline: {
        positions,
        width: 2,
        material: new Cesium.ColorMaterialProperty(color.withAlpha(0.55)),
        arcType: Cesium.ArcType.GEODESIC,
      },
      properties: { kind: 'auroral-oval', hemisphere },
    });
  }
  for (const point of points) {
    dataSource.entities.add({
      id: `space-weather:${hemisphere}:${point.sourceLongitude}`,
      position: Cesium.Cartesian3.fromDegrees(
        point.longitude,
        point.latitude,
        AURORA_ALTITUDE_M,
      ),
      point: pointStyle(color, point.probability),
      properties: {
        kind: 'auroral-probability-peak',
        hemisphere,
        probability: point.probability,
      },
    });
  }
}

export function createSpaceWeatherLayer({ fetchImpl = globalThis.fetch } = {}) {
  let _dataSource = null;
  let _snapshot = {
    wind: null,
    magneticField: null,
    planetaryK: null,
    aurora: null,
  };
  let _lastUpdate = null;
  let _lastFetch = null;
  let _lastError = null;
  let _status = 'nominal';

  function renderAurora() {
    if (!_dataSource || !_snapshot.aurora) return;
    _dataSource.entities.removeAll();
    addAuroraRing(_dataSource, 'north', _snapshot.aurora.north, NORTH_COLOR);
    addAuroraRing(_dataSource, 'south', _snapshot.aurora.south, SOUTH_COLOR);
  }

  const layer = {
    id: 'space-weather',
    name: 'Space Weather',
    icon: '☀️',
    source: 'NOAA SWPC',
    updateInterval: 120_000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('space-weather');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _lastUpdate = null;
      _lastFetch = null;
      _lastError = null;
      _status = 'nominal';
    },

    enable() {
      if (_dataSource) _dataSource.show = true;
    },

    disable() {
      if (_dataSource) _dataSource.show = false;
    },

    async update(_viewer, { signal = null } = {}) {
      const entries = Object.entries(FEEDS);
      const settled = await Promise.allSettled(
        entries.map(([, url]) => fetchJson(fetchImpl, url, signal)),
      );
      const errors = [];
      let freshComponents = 0;

      for (let index = 0; index < settled.length; index += 1) {
        const [key] = entries[index];
        const result = settled[index];
        if (result.status === 'rejected') {
          errors.push(`${key} ${result.reason?.message || 'unavailable'}`);
          continue;
        }
        const normalized = key === 'wind'
          ? normalizeSolarWind(result.value)
          : key === 'magneticField'
            ? normalizeMagneticField(result.value)
            : key === 'planetaryK'
              ? normalizePlanetaryK(result.value)
              : normalizeAuroraGrid(result.value);
        if (!normalized) {
          errors.push(`${key} malformed`);
          continue;
        }
        _snapshot[key] = normalized;
        freshComponents += 1;
      }

      _lastFetch = Date.now();
      _lastUpdate = latestSpaceWeatherObservation(_snapshot);
      _lastError = errors.length ? errors.join(' · ') : null;
      _status = freshComponents === 0
        ? (_lastUpdate ? 'stale' : 'unavailable')
        : (errors.length ? 'degraded' : 'nominal');

      if (freshComponents === 0) return false;
      renderAurora();
      return true;
    },

    destroy(viewer) {
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _snapshot = { wind: null, magneticField: null, planetaryK: null, aurora: null };
      _lastUpdate = null;
      _lastFetch = null;
      _lastError = null;
      _status = 'nominal';
    },

    getRowControls() {
      return {
        chips: [],
        legend: [
          { label: 'Northern oval', count: _snapshot.aurora?.north?.length || 0, color: '#8DFFB5' },
          { label: 'Southern oval', count: _snapshot.aurora?.south?.length || 0, color: '#55DDE0' },
        ],
      };
    },

    getStats() {
      const sourceAgeMs = _lastUpdate ? Date.now() - _lastUpdate : Infinity;
      return {
        count: (_snapshot.aurora?.north?.length || 0) + (_snapshot.aurora?.south?.length || 0),
        lastUpdate: _lastUpdate,
        fetchedAt: _lastFetch,
        stale: _status === 'stale' || sourceAgeMs > STALE_AFTER_MS,
        degraded: _status === 'degraded',
        status: _status,
        error: _lastError,
        loadingLabel: formatSpaceWeatherReadout(_snapshot),
      };
    },

    getSnapshot() {
      return JSON.parse(JSON.stringify(_snapshot));
    },
  };

  return layer;
}

const spaceWeatherLayer = createSpaceWeatherLayer();

export default spaceWeatherLayer;
