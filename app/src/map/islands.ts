/**
 * User-placed islands: they are drawn on the map with their real elevation and
 * get flooded when the tide rises above that elevation.
 */
import {Marker} from 'maplibre-gl';
import type {Map as MapLibreMap} from 'maplibre-gl';
import {t} from '../ui/i18n';

export interface Island {
  id: string;
  lng: number;
  lat: number;
  /** peak elevation in metres above mean sea level */
  elevation: number;
  /** radius in kilometres */
  radiusKm: number;
  name: string;
}

const SOURCE = 'user-islands';

export class IslandManager {
  private markers: Marker[] = [];
  private islands: Island[] = [];
  private tide = 0;
  private counter = 0;

  constructor(private map: MapLibreMap) {
    this.map.addSource(SOURCE, {
      type: 'geojson',
      data: {type: 'FeatureCollection', features: []},
    });
    this.map.addLayer({
      id: 'user-islands-fill',
      type: 'circle',
      source: SOURCE,
      paint: {
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          0,
          ['*', ['get', 'radiusM'], 0.000006389, ['/', 1, ['cos', ['*', ['get', 'lat'], 0.01745329252]]]],
          10,
          ['*', ['get', 'radiusM'], 0.006542, ['/', 1, ['cos', ['*', ['get', 'lat'], 0.01745329252]]]],
          16,
          ['*', ['get', 'radiusM'], 0.41874, ['/', 1, ['cos', ['*', ['get', 'lat'], 0.01745329252]]]],
        ],
        'circle-color': [
          'case',
          ['>', ['get', 'elevation'], ['get', 'tide']],
          '#e8c37a',
          '#2e6f9e',
        ],
        'circle-opacity': 0.55,
        'circle-stroke-width': 2,
        'circle-stroke-color': [
          'case',
          ['>', ['get', 'elevation'], ['get', 'tide']],
          '#ffd166',
          '#9ad7ff',
        ],
      },
    });
  }

  get list(): Island[] {
    return this.islands;
  }

  add(lng: number, lat: number, elevation: number, radiusKm: number): Island {
    const island: Island = {
      id: `island-${++this.counter}`,
      lng,
      lat,
      elevation,
      radiusKm,
      name: `${t('addIsland')} ${this.counter}`,
    };
    this.islands.push(island);
    this.render();
    return island;
  }

  remove(id: string) {
    this.islands = this.islands.filter((i) => i.id !== id);
    this.render();
  }

  clear() {
    this.islands = [];
    this.render();
  }

  /** called whenever the tide level changes */
  updateTide(tide: number) {
    this.tide = tide;
    const data = {
      type: 'FeatureCollection' as const,
      features: this.islands.map((i) => ({
        type: 'Feature' as const,
        geometry: {type: 'Point' as const, coordinates: [i.lng, i.lat]},
        properties: {
          id: i.id,
          elevation: i.elevation,
          tide: this.tide,
          radiusM: i.radiusKm * 1000,
          lat: i.lat,
        },
      })),
    };
    (this.map.getSource(SOURCE) as any).setData(data);
    for (const m of this.markers) {
      const el = m.getElement();
      const island = this.islands.find((i) => i.id === el.dataset.id);
      if (!island) continue;
      const flooded = this.tide > island.elevation;
      el.classList.toggle('flooded', flooded);
      const state = el.querySelector('.island-state');
      if (state) state.textContent = flooded ? t('flooded') : t('exposed');
    }
  }

  private render() {
    for (const m of this.markers) m.remove();
    this.markers = [];
    for (const island of this.islands) {
      const el = document.createElement('div');
      el.className = 'island-marker';
      el.dataset.id = island.id;
      el.innerHTML = `<span class="island-name">${island.name}</span><span class="island-meta">${island.elevation.toFixed(
        1,
      )} m</span><span class="island-state">${this.tide > island.elevation ? t('flooded') : t('exposed')}</span>`;
      this.markers.push(this.makeMarker(el, island));
    }
    this.updateTide(this.tide);
  }

  private makeMarker(el: HTMLElement, island: Island): Marker {
    const marker = new Marker({element: el, anchor: 'bottom'}).setLngLat([island.lng, island.lat]);
    marker.addTo(this.map);
    return marker;
  }
}
