// Import Mapbox GL JS & D3 as ES modules
import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// Check Mapbox GL loaded
console.log('Mapbox GL JS Loaded:', mapboxgl);

// Set your Mapbox access token
mapboxgl.accessToken =
  'pk.eyJ1IjoiaWdvYnl3ZW5keSIsImEiOiJjbWh6a2pwanEwb21vMmxvcGxleXFyeW4zIn0.U5-gixdPuBW6FQ3PQiEI8A';

// Initialize the map
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
  center: [-71.09415, 42.36027],
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
});

// --- Global helpers & state ---

// Quantized scale for departure ratio -> 0, 0.5, 1
const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

// Format minutes since midnight -> "HH:MM AM/PM"
function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

// Minutes since midnight for a Date
function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// Filter trips based on a time filter (minutes since midnight, ±60 min window)
function filterTripsByTime(trips, timeFilter) {
  if (timeFilter === -1) return trips;

  return trips.filter((trip) => {
    const startedMinutes = minutesSinceMidnight(trip.started_at);
    const endedMinutes = minutesSinceMidnight(trip.ended_at);

    return (
      Math.abs(startedMinutes - timeFilter) <= 60 ||
      Math.abs(endedMinutes - timeFilter) <= 60
    );
  });
}

// Compute arrivals/departures/total per station
function computeStationTraffic(stations, trips) {
  const departures = d3.rollup(
    trips,
    (v) => v.length,
    (d) => d.start_station_id,
  );

  const arrivals = d3.rollup(
    trips,
    (v) => v.length,
    (d) => d.end_station_id,
  );

  return stations.map((station) => {
    const id = station.short_name;
    const arr = arrivals.get(id) ?? 0;
    const dep = departures.get(id) ?? 0;

    station.arrivals = arr;
    station.departures = dep;
    station.totalTraffic = arr + dep;
    return station;
  });
}

// Convert station lon/lat to SVG coordinates using map.project()
function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

// Global state to reuse across updates
let stationsAll = [];
let tripsAll = [];
let circles;
let radiusScale;

// --- Main logic: run after map loads ---

map.on('load', async () => {
  // 1) Add Boston bike lanes from local GeoJSON (your attached dataset)
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'Existing_Bike_Network_2022.geojson', // file in repo root
  });

  const bikeLinePaint = {
    'line-color': '#32D400',
    'line-width': 3,
    'line-opacity': 0.5,
  };

  map.addLayer({
    id: 'bike-lanes-boston',
    type: 'line',
    source: 'boston_route',
    paint: bikeLinePaint,
  });

  // 2) Add Cambridge bike lanes via GeoJSON from Cambridge GIS
  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson',
  });

  map.addLayer({
    id: 'bike-lanes-cambridge',
    type: 'line',
    source: 'cambridge_route',
    paint: bikeLinePaint,
  });

  // 3) Select overlay SVG
  const svg = d3.select('#map').select('svg');

  // 4) Load Bluebikes station JSON
  let jsonData;
  try {
    const jsonUrl =
      'https://dsc106.com/labs/lab07/data/bluebikes-stations.json';
    jsonData = await d3.json(jsonUrl);
    console.log('Loaded JSON Data:', jsonData);
  } catch (error) {
    console.error('Error loading stations JSON:', error);
    return;
  }

  let stations = jsonData.data.stations;
  console.log('Stations Array:', stations);

  // Normalize station structure for our helpers:
  // - create short_name from Number
  // - convert Lat/Long to lon/lat numeric fields
  stations = stations.map((s) => ({
    ...s,
    short_name: s.short_name ?? s.Number,
    lon: s.lon ?? s.Long,
    lat: s.lat ?? s.Lat,
  }));

  // 5) Load trips CSV and parse dates
  let trips = await d3.csv(
    'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
    (trip) => {
      trip.started_at = new Date(trip.started_at);
      trip.ended_at = new Date(trip.ended_at);
      return trip;
    },
  );

  console.log('Loaded trips:', trips.length);

  stationsAll = stations;
  tripsAll = trips;

  // 6) Compute baseline traffic and scaling
  stations = computeStationTraffic(stationsAll, tripsAll);

  radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic)])
    .range([0, 25]);

  // 7) Create circles for each station
  circles = svg
    .selectAll('circle')
    .data(stations, (d) => d.short_name)
    .enter()
    .append('circle')
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .attr('opacity', 0.8)
    .style('--departure-ratio', (d) =>
      d.totalTraffic
        ? stationFlow(d.departures / d.totalTraffic)
        : stationFlow(0.5),
    )
    .each(function (d) {
      d3.select(this)
        .append('title')
        .text(
          `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`,
        );
    });

  // 8) Position circles according to map view
  function updatePositions() {
    circles
      .attr('cx', (d) => getCoords(d).cx)
      .attr('cy', (d) => getCoords(d).cy);
  }

  updatePositions();

  map.on('move', updatePositions);
  map.on('zoom', updatePositions);
  map.on('resize', updatePositions);
  map.on('moveend', updatePositions);

  // 9) Slider + time filter wiring
  const timeSlider = document.getElementById('time-slider');
  const selectedTime = document.getElementById('selected-time');
  const anyTimeLabel = document.getElementById('any-time');

  let currentTimeFilter = -1;

  function updateScatterPlot(timeFilter) {
    const filteredTrips = filterTripsByTime(tripsAll, timeFilter);
    const filteredStations = computeStationTraffic(stationsAll, filteredTrips);

    // Dynamic radius range: larger when filtered
    if (timeFilter === -1) {
      radiusScale.range([0, 25]);
    } else {
      radiusScale.range([3, 50]);
    }

    circles = svg
      .selectAll('circle')
      .data(filteredStations, (d) => d.short_name)
      .join(
        (enter) =>
          enter
            .append('circle')
            .attr('opacity', 0.8)
            .each(function (d) {
              d3.select(this)
                .append('title')
                .text(
                  `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`,
                );
            }),
        (update) => update,
        (exit) => exit.remove(),
      )
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .style('--departure-ratio', (d) =>
        d.totalTraffic
          ? stationFlow(d.departures / d.totalTraffic)
          : stationFlow(0.5),
      );

    updatePositions();
  }

  function updateTimeDisplay() {
    currentTimeFilter = Number(timeSlider.value);

    if (currentTimeFilter === -1) {
      selectedTime.textContent = '';
      anyTimeLabel.style.display = 'block';
    } else {
      selectedTime.textContent = formatTime(currentTimeFilter);
      anyTimeLabel.style.display = 'none';
    }

    updateScatterPlot(currentTimeFilter);
  }

  timeSlider.addEventListener('input', updateTimeDisplay);
  updateTimeDisplay();
});
