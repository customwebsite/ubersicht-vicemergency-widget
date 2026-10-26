/**
 * VicEmergency Desktop Widget for Übersicht
 *
 * Displays Victorian emergency incidents on your Mac desktop
 * with an interactive Leaflet map.
 *
 * Installation:
 *   1. Install Übersicht: https://tracesof.net/uebersicht/
 *   2. Copy this file to ~/Library/Application Support/Übersicht/widgets/
 *   3. Edit HOME_LAT / HOME_LON below to your location
 *   4. Optionally adjust RADIUS_KM and WIDGET_POSITION
 *
 * @version 1.5.0
 * @see https://github.com/customwebsite/vicemergency-ha
 */

// ─────────────────────────────────────────────────────────────
// ▸ DEFAULT CONFIGURATION — overridden by ~/.vicemergency-config.json
// ─────────────────────────────────────────────────────────────

const DEFAULTS = {
  HOME_LAT: -37.40,
  HOME_LON: 144.59,
  RADIUS_KM: 50,
  ZONE_NAME: "Home",
  MAX_INCIDENTS: 8,
  EXCLUDE_BURN_AREA: true,
  SHOW_MAP: "auto",
  MAP_HEIGHT: 260,
  MAP_ZOOM: 10,
  MAP_THEME: "light",
  HIDE_WHEN_CLEAR: false,
  SHOW_EARTHQUAKES: true,
  QUAKE_MIN_MAG: 2.0,
  QUAKE_MAX_AGE_H: 72,
  ABC_STATION: "auto",   // "auto" = nearest by home location, or an ABC listen slug e.g. "shepparton"
};

const CONFIG_PATH = "$HOME/.vicemergency-config.json";

const WIDGET_POSITION = {         // Screen position (edit here, not in settings)
  top: "20px",
  right: "20px",
};

// ─────────────────────────────────────────────────────────────
// ▸ ÜBERSICHT HOOKS
// ─────────────────────────────────────────────────────────────

export const refreshFrequency = 120_000; // 2 minutes

// Three-tier feed fallback: GeoJSON → JSON → XML with format tagging
export const command = `
  echo '{"config":';
  cat ${CONFIG_PATH} 2>/dev/null || echo '{}';
  echo ',"feed":';
  FEED=$(curl -sf --compressed --max-time 10 "https://emergency.vic.gov.au/public/osom-geojson.json" 2>/dev/null);
  if [ -n "$FEED" ]; then
    echo "{\\"_format\\":\\"geojson\\",\\"data\\":$FEED}";
  else
    FEED=$(curl -sf --compressed --max-time 10 "https://data.emergency.vic.gov.au/Show?pageId=getIncidentJSON" 2>/dev/null);
    if [ -n "$FEED" ]; then
      echo "{\\"_format\\":\\"json\\",\\"data\\":$FEED}";
    else
      FEED=$(curl -sf --compressed --max-time 10 "https://data.emergency.vic.gov.au/Show?pageId=getIncidentXML" 2>/dev/null);
      if [ -n "$FEED" ]; then
        echo "{\\"_format\\":\\"xml\\",\\"data\\":\\"XMLSTART\\"}" | sed "s/XMLSTART/$(echo "$FEED" | base64 | tr -d '\\n')/";
      else
        echo "{\\"error\\":true}";
      fi;
    fi;
  fi;
  echo ',"quakes":';
  QUAKES=$(curl -sf --compressed --max-time 10 "https://earthquakes.ga.gov.au/geoserver/earthquakes/wfs?service=WFS&request=getfeature&typeNames=earthquakes:earthquakes_seven_days&outputFormat=application/json" 2>/dev/null);
  if [ -n "$QUAKES" ]; then echo "$QUAKES"; else echo 'null'; fi;
  echo '}'
`;

import { run } from "uebersicht";

export const init = (dispatch) => {};

// Persistent state (survives re-renders, resets on widget reload)
let _collapsed = false;
let _prevIncidentCount = undefined;
let _lastClickedIdx = null;
let _settingsOpen = false;

// ─────────────────────────────────────────────────────────────
// ▸ DATA LAYER — ported from vicemergency-ha parser
// ─────────────────────────────────────────────────────────────

const CATEGORY_GROUPS = {
  "Fire":"fire","Bushfire":"fire","Planned Burn":"fire","Burn Area":"fire","Burn Advice":"fire",
  "Flood":"flood","Flooding":"flood","Riverine Flood":"flood","Flash Flood":"flood","Coastal Flood":"flood","Dam Failure":"flood",
  "Storm":"storm_weather","Severe Storm":"storm_weather","Severe Weather":"storm_weather",
  "Severe Thunderstorm":"storm_weather","Damaging Winds":"storm_weather","Tornado/Cyclone":"storm_weather",
  "Met":"storm_weather","Earthquake":"storm_weather","Tsunami":"storm_weather","Landslide":"storm_weather",
  "Vehicle Accident":"transport","Aircraft Accident":"transport","Rail Accident":"transport",
  "Marine Accident":"transport","Rescue":"transport","Accident / Rescue":"transport",
  "Hazardous Material":"hazmat_health","Medical":"hazmat_health","Animal Health":"hazmat_health",
  "Dangerous Animal":"hazmat_health","Oiled Wildlife":"hazmat_health","Animal Plague":"hazmat_health",
  "Insect Plague":"hazmat_health","Shark Sighting":"hazmat_health","Water Pollution":"hazmat_health",
  "Plant Health":"hazmat_health","Env":"hazmat_health",
  "Tree Down":"outages_closures","Building Damage":"outages_closures","Fallen Power Lines":"outages_closures",
  "Road Closed":"outages_closures","Road Affected":"outages_closures","Rail Disruption":"outages_closures",
  "Power Outage":"outages_closures","Gas Outage":"outages_closures","Water Outage":"outages_closures",
  "Park/Forest Closure":"outages_closures","Beach Closure":"outages_closures","School Closure":"outages_closures",
};

const FEEDTYPE_WARNING = {
  "warning": "advice",
  "watch-and-act": "watch_and_act",
  "emergency-warning": "emergency_warning",
};

const WARNING_PRIORITY = { "advice": 1, "watch_and_act": 2, "emergency_warning": 3 };

// category1 can be a generic label ("Advice", "Community Update"); category2 then holds the hazard
function getGroup(category1, eventType, category2) {
  return CATEGORY_GROUPS[category1] || (eventType && CATEGORY_GROUPS[eventType])
    || (category2 && CATEGORY_GROUPS[category2]) || "other";
}

function extractCoords(geometry) {
  if (!geometry) return null;
  const t = geometry.type;

  if (t === "GeometryCollection") {
    const geoms = geometry.geometries || [];
    for (const g of geoms) {
      if (g.type === "Point" && g.coordinates?.length >= 2)
        return { lat: g.coordinates[1], lon: g.coordinates[0] };
    }
    for (const g of geoms) {
      const r = extractCoords(g);
      if (r) return r;
    }
    return null;
  }

  const c = geometry.coordinates;
  if (!c) return null;

  if (t === "Point") return { lat: c[1], lon: c[0] };
  if (t === "Polygon") return centroid(c[0]);
  if (t === "MultiPolygon") return centroid(c[0][0]);
  return null;
}

function centroid(ring) {
  const n = ring.length;
  let sLat = 0, sLon = 0;
  for (const p of ring) { sLon += p[0]; sLat += p[1]; }
  return { lat: sLat / n, lon: sLon / n };
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function compassBearing(lat1, lon1, lat2, lon2) {
  const toRad = (d) => d * Math.PI / 180;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  const pts = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return pts[Math.floor((deg + 11.25) / 22.5) % 16];
}

function parseFeed(raw, cfg) {
  try {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (data.error) return { error: "Feed unavailable", incidents: [], feedSource: "none" };

    const format = data._format || "geojson";
    const feedData = data.data || data;

    let rawIncidents;
    if (format === "geojson") {
      rawIncidents = parseGeoJSON(feedData, cfg);
    } else if (format === "json") {
      rawIncidents = parseJSONFallback(feedData, cfg);
    } else if (format === "xml") {
      rawIncidents = parseXMLFallback(feedData, cfg);
    } else {
      // Try as GeoJSON if no format tag (backward compat)
      rawIncidents = parseGeoJSON(feedData, cfg);
    }

    rawIncidents.sort((a, b) => a.distance - b.distance);
    return { error: null, incidents: rawIncidents, feedSource: format };

  } catch (e) {
    return { error: `Parse error: ${e.message}`, incidents: [], feedSource: "none" };
  }
}

function parseGeoJSON(data, cfg) {
  const features = data.features || [];
  const incidents = [];

  for (const f of features) {
    const p = f.properties || {};
    const id = p.id;
    if (!id) continue;

    if (cfg.EXCLUDE_BURN_AREA && p.feedType === "burn-area") continue;

    const coords = extractCoords(f.geometry);
    if (!coords) continue;

    const cap = typeof p.cap === "object" ? p.cap : {};
    const eventType = cap.event || null;

    const dist = haversine(cfg.HOME_LAT, cfg.HOME_LON, coords.lat, coords.lon);
    if (dist > cfg.RADIUS_KM) continue;

    const bearing = compassBearing(cfg.HOME_LAT, cfg.HOME_LON, coords.lat, coords.lon);
    const group = getGroup(p.category1, eventType, p.category2);
    const warningLevel = FEEDTYPE_WARNING[p.feedType] || null;

    incidents.push({
      id: String(id),
      title: p.sourceTitle || "",
      category1: p.category1 || "",
      category2: p.category2 || "",
      eventType,
      feedType: p.feedType || "incident",
      status: p.status || "",
      location: p.location || "",
      sourceOrg: p.sourceOrg || "",
      resources: parseInt(p.resources) || 0,
      group,
      warningLevel,
      distance: Math.round(dist * 10) / 10,
      bearing,
      lat: coords.lat,
      lon: coords.lon,
    });
  }
  return incidents;
}

function parseJSONFallback(data, cfg) {
  const results = data.results || data.incidents || (Array.isArray(data) ? data : []);
  const incidents = [];

  for (const item of results) {
    const id = item.incidentNo || item.id;
    if (!id) continue;

    if (cfg.EXCLUDE_BURN_AREA && item.feedType === "burn-area") continue;

    const lat = parseFloat(item.latitude || item.lat);
    const lon = parseFloat(item.longitude || item.lon || item.long);
    if (!lat || !lon) continue;

    const dist = haversine(cfg.HOME_LAT, cfg.HOME_LON, lat, lon);
    if (dist > cfg.RADIUS_KM) continue;

    const bearing = compassBearing(cfg.HOME_LAT, cfg.HOME_LON, lat, lon);
    const category1 = item.category1 || "";
    const group = getGroup(category1, null, item.category2);
    const warningLevel = FEEDTYPE_WARNING[item.feedType] || null;

    incidents.push({
      id: String(id),
      title: item.name || item.sourceTitle || "",
      category1,
      category2: item.category2 || "",
      eventType: null,
      feedType: item.feedType || "incident",
      status: item.incidentStatus || item.status || "",
      location: item.incidentLocation || item.location || "",
      sourceOrg: item.agency || item.sourceOrg || "",
      resources: parseInt(item.resourceCount || item.resources) || 0,
      group,
      warningLevel,
      distance: Math.round(dist * 10) / 10,
      bearing,
      lat,
      lon,
    });
  }
  return incidents;
}

function parseXMLFallback(data, cfg) {
  // data is base64-encoded XML string
  const xmlStr = typeof data === "string" ? atob(data) : "";
  if (!xmlStr) return [];

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, "text/xml");
  const items = doc.querySelectorAll("incident");
  const incidents = [];

  for (const el of items) {
    const txt = (tag) => { const n = el.querySelector(tag); return n ? n.textContent.trim() : ""; };
    const id = txt("id");
    if (!id) continue;

    if (cfg.EXCLUDE_BURN_AREA && txt("feedType") === "burn-area") continue;

    const lat = parseFloat(txt("lat"));
    const lon = parseFloat(txt("lon") || txt("long"));
    if (!lat || !lon) continue;

    const dist = haversine(cfg.HOME_LAT, cfg.HOME_LON, lat, lon);
    if (dist > cfg.RADIUS_KM) continue;

    const bearing = compassBearing(cfg.HOME_LAT, cfg.HOME_LON, lat, lon);
    const category1 = txt("category1");
    const group = getGroup(category1, null, txt("category2"));
    const warningLevel = FEEDTYPE_WARNING[txt("feedType")] || null;

    incidents.push({
      id,
      title: txt("sourceTitle"),
      category1,
      category2: txt("category2"),
      eventType: null,
      feedType: txt("feedType") || "incident",
      status: txt("status"),
      location: txt("location"),
      sourceOrg: txt("sourceOrg"),
      resources: parseInt(txt("resources")) || 0,
      group,
      warningLevel,
      distance: Math.round(dist * 10) / 10,
      bearing,
      lat,
      lon,
    });
  }
  return incidents;
}

// Geoscience Australia earthquakes (earthquakes.ga.gov.au) — past 7 days, GeoJSON
function parseQuakes(data, cfg) {
  if (!cfg.SHOW_EARTHQUAKES || !data || !Array.isArray(data.features)) return [];
  const now = Date.now();
  const quakes = [];
  for (const f of data.features) {
    const p = f.properties || {};
    const c = (f.geometry && f.geometry.coordinates) || [];
    const lat = parseFloat(p.latitude != null ? p.latitude : c[1]);
    const lon = parseFloat(p.longitude != null ? p.longitude : c[0]);
    const mag = parseFloat(p.preferred_magnitude);
    if (!lat || !lon || isNaN(mag)) continue;
    if (mag < cfg.QUAKE_MIN_MAG) continue;

    const t = Date.parse(p.origin_time || p.epicentral_time || "");
    const ageH = isNaN(t) ? null : (now - t) / 3600000;
    if (ageH !== null && ageH > cfg.QUAKE_MAX_AGE_H) continue;

    const dist = haversine(cfg.HOME_LAT, cfg.HOME_LON, lat, lon);
    if (dist > cfg.RADIUS_KM) continue;

    const ago = ageH === null ? "" : ageH < 1 ? "<1 h ago" : ageH < 48 ? `${Math.round(ageH)} h ago` : `${Math.round(ageH / 24)} days ago`;
    const felt = parseInt(p.felt_reports_count) || 0;
    quakes.push({
      id: `ga-${p.event_id || p.earthquake_id || f.id}`,
      title: p.description || "",
      category1: "Earthquake",
      category2: "",
      eventType: `M${mag.toFixed(1)} Earthquake`,
      feedType: "incident",
      status: [ago, felt > 0 ? `${felt} felt report${felt !== 1 ? "s" : ""}` : ""].filter(Boolean).join(" \u00b7 "),
      location: p.description || "",
      sourceOrg: "Geoscience Australia",
      resources: 0,
      group: getGroup("Earthquake", null),
      warningLevel: null,
      distance: Math.round(dist * 10) / 10,
      bearing: compassBearing(cfg.HOME_LAT, cfg.HOME_LON, lat, lon),
      lat,
      lon,
    });
  }
  return quakes;
}

// ─────────────────────────────────────────────────────────────
// ▸ EMERGENCY RADIO — official emergency broadcaster for the home location
// Source: Emergency Management Victoria, "Emergency radio broadcasters (Regional)";
// ABC transmitters per station. Live audio: streaming.abc-cdn.net.au/audio/hls/local<slug>.m3u8
// (played in QuickTime Player; falls back to the abc.net.au/listen/live/<slug> page).
// ─────────────────────────────────────────────────────────────

const ABC_STATIONS = {
  melbourne:       "ABC Melbourne",
  ballarat:        "ABC Ballarat",
  centralvic:      "ABC Central Victoria",
  gippsland:       "ABC Gippsland",
  goulburnmurray:  "ABC Goulburn Murray",
  milduraswanhill: "ABC Mildura-Swan Hill",
  shepparton:      "ABC Shepparton",
  southwestvic:    "ABC South West Victoria",
  wimmera:         "ABC Wimmera",
};

// [lat, lon, station slug, frequency, town] — nearest town decides the station
const ABC_POINTS = [
  [-37.81, 144.96, "melbourne", "774 AM", "Melbourne"],
  [-38.15, 144.36, "melbourne", "774 AM", "Geelong"],
  [-38.33, 144.33, "melbourne", "774 AM", "Torquay"],
  [-38.54, 143.98, "melbourne", "774 AM", "Lorne"],
  [-38.76, 143.67, "melbourne", "89.5 FM", "Apollo Bay"],
  [-37.68, 144.44, "melbourne", "774 AM", "Bacchus Marsh"],
  [-37.68, 144.58, "melbourne", "774 AM", "Melton"],
  [-37.58, 144.73, "melbourne", "774 AM", "Sunbury"],
  [-37.49, 144.59, "melbourne", "774 AM", "Gisborne"],
  [-37.36, 144.53, "melbourne", "774 AM", "Woodend"],
  [-37.30, 144.95, "melbourne", "774 AM", "Kilmore"],
  [-37.21, 145.43, "melbourne", "774 AM", "Yea"],
  [-37.65, 145.52, "melbourne", "774 AM", "Healesville"],
  [-37.75, 145.69, "melbourne", "96.1 FM", "Warburton"],
  [-38.36, 144.91, "melbourne", "774 AM", "Rosebud"],
  [-38.20, 145.49, "melbourne", "774 AM", "Koo Wee Rup"],
  [-38.48, 145.23, "melbourne", "774 AM", "Phillip Island"],
  [-38.61, 145.59, "melbourne", "774 AM", "Wonthaggi"],
  [-38.16, 145.93, "melbourne", "774 AM", "Warragul"],
  [-37.56, 143.85, "ballarat", "107.9 FM", "Ballarat"],
  [-37.28, 142.93, "ballarat", "107.9 FM", "Ararat"],
  [-37.09, 143.47, "ballarat", "107.9 FM", "Avoca"],
  [-37.43, 143.38, "ballarat", "107.9 FM", "Beaufort"],
  [-37.35, 144.14, "ballarat", "107.9 FM", "Daylesford"],
  [-38.34, 143.58, "ballarat", "107.9 FM", "Colac"],
  [-38.23, 143.15, "ballarat", "107.9 FM", "Camperdown"],
  [-36.76, 144.28, "centralvic", "91.1 FM", "Bendigo"],
  [-37.06, 144.22, "centralvic", "91.1 FM", "Castlemaine"],
  [-37.25, 144.45, "centralvic", "91.1 FM", "Kyneton"],
  [-37.05, 143.74, "centralvic", "91.1 FM", "Maryborough"],
  [-36.92, 144.71, "centralvic", "91.1 FM", "Heathcote"],
  [-36.13, 144.75, "centralvic", "91.1 FM", "Echuca"],
  [-36.62, 143.26, "centralvic", "91.1 FM", "St Arnaud"],
  [-37.03, 145.14, "centralvic", "91.1 FM", "Seymour"],
  [-36.38, 145.40, "shepparton", "97.7 FM", "Shepparton"],
  [-36.31, 145.05, "shepparton", "97.7 FM", "Kyabram"],
  [-36.59, 145.02, "shepparton", "97.7 FM", "Rushworth"],
  [-36.79, 145.15, "shepparton", "97.7 FM", "Nagambie"],
  [-36.75, 145.57, "shepparton", "97.7 FM", "Euroa"],
  [-36.55, 145.98, "shepparton", "97.7 FM", "Benalla"],
  [-35.92, 145.65, "shepparton", "97.7 FM", "Cobram"],
  [-36.02, 146.00, "shepparton", "97.7 FM", "Yarrawonga"],
  [-37.05, 146.08, "shepparton", "103.7 FM", "Mansfield"],
  [-37.23, 145.91, "shepparton", "98.1 FM", "Eildon"],
  [-37.19, 145.71, "shepparton", "102.9 FM", "Alexandra"],
  [-36.12, 146.89, "goulburnmurray", "106.5 FM", "Wodonga"],
  [-36.08, 146.92, "goulburnmurray", "106.5 FM", "Albury"],
  [-36.36, 146.32, "goulburnmurray", "106.5 FM", "Wangaratta"],
  [-36.36, 146.69, "goulburnmurray", "106.5 FM", "Beechworth"],
  [-36.05, 146.46, "goulburnmurray", "106.5 FM", "Rutherglen"],
  [-36.22, 147.18, "goulburnmurray", "106.5 FM", "Tallangatta"],
  [-36.74, 147.17, "goulburnmurray", "106.5 FM", "Mount Beauty"],
  [-36.56, 146.72, "goulburnmurray", "91.7 FM", "Myrtleford"],
  [-36.73, 146.96, "goulburnmurray", "89.7 FM", "Bright"],
  [-36.89, 147.06, "goulburnmurray", "98.7 FM", "Harrietville"],
  [-36.20, 147.90, "goulburnmurray", "99.7 FM", "Corryong"],
  [-38.11, 147.07, "gippsland", "828 AM", "Sale"],
  [-37.97, 146.98, "gippsland", "828 AM", "Maffra"],
  [-38.20, 146.54, "gippsland", "100.7 FM", "Traralgon"],
  [-38.24, 146.40, "gippsland", "100.7 FM", "Morwell"],
  [-38.18, 146.26, "gippsland", "100.7 FM", "Moe"],
  [-38.48, 145.95, "gippsland", "828 AM", "Leongatha"],
  [-38.65, 146.20, "gippsland", "100.7 FM", "Foster"],
  [-38.56, 146.68, "gippsland", "828 AM", "Yarram"],
  [-37.83, 147.61, "gippsland", "100.7 FM", "Bairnsdale"],
  [-37.88, 147.99, "gippsland", "100.7 FM", "Lakes Entrance"],
  [-37.10, 147.60, "gippsland", "720 AM", "Omeo"],
  [-37.71, 148.46, "gippsland", "97.1 FM", "Orbost"],
  [-37.57, 149.15, "gippsland", "106.1 FM", "Cann River"],
  [-37.56, 149.75, "gippsland", "104.9 FM", "Mallacoota"],
  [-34.19, 142.16, "milduraswanhill", "104.3 FM", "Mildura"],
  [-34.58, 142.77, "milduraswanhill", "104.3 FM", "Robinvale"],
  [-35.34, 143.55, "milduraswanhill", "102.1 FM", "Swan Hill"],
  [-35.73, 143.92, "milduraswanhill", "102.1 FM", "Kerang"],
  [-38.38, 142.48, "southwestvic", "1602 AM", "Warrnambool"],
  [-38.38, 142.24, "southwestvic", "1602 AM", "Port Fairy"],
  [-38.08, 142.80, "southwestvic", "1602 AM", "Mortlake"],
  [-37.74, 142.02, "southwestvic", "94.1 FM", "Hamilton"],
  [-37.59, 141.40, "southwestvic", "94.1 FM", "Casterton"],
  [-37.60, 141.69, "southwestvic", "94.1 FM", "Coleraine"],
  [-38.34, 141.60, "southwestvic", "96.9 FM", "Portland"],
  [-38.13, 141.63, "southwestvic", "96.9 FM", "Heywood"],
  [-36.71, 142.20, "wimmera", "594 AM", "Horsham"],
  [-36.45, 142.03, "wimmera", "594 AM", "Dimboola"],
  [-36.33, 141.65, "wimmera", "594 AM", "Nhill"],
  [-36.25, 142.39, "wimmera", "594 AM", "Warracknabeal"],
  [-37.04, 141.29, "wimmera", "594 AM", "Edenhope"],
  [-37.06, 142.78, "wimmera", "594 AM", "Stawell"],
  [-36.37, 142.98, "wimmera", "594 AM", "Donald"],
  [-36.26, 143.35, "wimmera", "594 AM", "Charlton"],
  [-35.73, 142.37, "wimmera", "594 AM", "Hopetoun"],
  [-35.07, 142.32, "wimmera", "594 AM", "Ouyen"],
];

// Local community broadcasters named as official emergency broadcasters for these towns.
// "stream" is played in QuickTime Player; "url" (station website) is the fallback.
// (shown when home is within LOCAL_RADIO_KM of one of them)
const LOCAL_RADIO_KM = 25;
const LOCAL_BROADCASTERS = [
  { name: "UGFM", url: "https://ugfm.org/", stream: "https://radio.turbo.net.au:8443/ugfm-live", towns: [
    [-37.19, 145.71, "106.9 FM"], [-37.23, 145.91, "106.9 FM"], [-37.05, 146.08, "106.9 FM"],
    [-37.21, 145.43, "88.9 FM"], [-37.53, 145.33, "94.5 FM"], [-37.51, 145.75, "98.5 FM"],
    [-37.34, 145.29, "98.9 FM"], [-37.23, 145.22, "98.9 FM"] ] },
  { name: "Radio Mansfield", url: "https://radiomansfield.org.au/", stream: "https://c7.radioboss.fm:18291/stream", towns: [
    [-37.05, 146.08, "99.7 FM"], [-37.23, 145.91, "99.7 FM"] ] },
  { name: "Alpine Radio", url: "https://www.alpinefm.org.au/", stream: "https://stream.sigile.net/3vkv-128-mp3", towns: [
    [-36.73, 146.96, "92.9 FM"], [-36.89, 147.06, "92.9 FM"], [-36.74, 147.17, "96.5 FM"],
    [-36.87, 147.28, "96.5 FM"], [-36.45, 147.00, "96.5 FM"] ] },
  { name: "Radio KLFM", url: null, stream: "https://streamer5.rightclickitservices.com:18006/aac", towns: [
    [-36.76, 144.28, "96.5 FM"], [-36.92, 144.71, "96.5 FM"], [-37.06, 144.22, "96.5 FM"],
    [-37.25, 144.45, "96.5 FM"], [-36.50, 144.61, "96.5 FM"], [-36.57, 143.87, "96.5 FM"],
    [-36.36, 144.70, "96.5 FM"] ] },
  { name: "Plenty Valley", url: "https://www.pvfm.org.au/", stream: "https://playerservices.streamtheworld.com/api/livestream-redirect/3PVR.mp3", towns: [
    [-37.71, 145.15, "88.6 FM"], [-37.65, 145.02, "88.6 FM"], [-37.70, 145.10, "88.6 FM"],
    [-37.64, 145.19, "88.6 FM"], [-37.68, 145.02, "88.6 FM"], [-37.51, 145.12, "88.6 FM"] ] },
  { name: "Radio Eastern", url: "https://www.radioeasternfm.com.au/", stream: "https://playerservices.streamtheworld.com/api/livestream-redirect/3ECBAAC.aac", towns: [
    [-37.80, 145.28, "98.1 FM"], [-37.76, 145.35, "98.1 FM"] ] },
];

function pickRadio(cfg) {
  let best = null;
  for (const [lat, lon, slug, freq, town] of ABC_POINTS) {
    const d = haversine(cfg.HOME_LAT, cfg.HOME_LON, lat, lon);
    if (!best || d < best.d) best = { d, slug, freq, town };
  }
  let slug = best && best.d <= 150 ? best.slug : "melbourne";
  let freq = best && best.d <= 150 ? best.freq : "774 AM";
  if (cfg.ABC_STATION && cfg.ABC_STATION !== "auto" && ABC_STATIONS[cfg.ABC_STATION]) {
    slug = cfg.ABC_STATION;
    const p = ABC_POINTS.find((x) => x[2] === slug);
    freq = p ? p[3] : "";
  }
  const abc = {
    name: ABC_STATIONS[slug],
    freq,
    url: `https://www.abc.net.au/listen/live/${slug}`,
    stream: `https://streaming.abc-cdn.net.au/audio/hls/local${slug}.m3u8`,
  };

  const local = [];
  for (const b of LOCAL_BROADCASTERS) {
    let near = null;
    for (const [lat, lon, f] of b.towns) {
      const d = haversine(cfg.HOME_LAT, cfg.HOME_LON, lat, lon);
      if (d <= LOCAL_RADIO_KM && (!near || d < near.d)) near = { d, f };
    }
    if (near) local.push({ name: b.name, freq: near.f, url: b.url, stream: b.stream });
  }
  return { abc, local };
}

// ─────────────────────────────────────────────────────────────
// ▸ MAP — self-contained Leaflet in an iframe
// ─────────────────────────────────────────────────────────────

const GROUP_COLOURS = {
  fire: "#E53935", flood: "#42A5F5", storm_weather: "#AB47BC",
  transport: "#FB8C00", hazmat_health: "#66BB6A", outages_closures: "#78909C",
  other: "#BDBDBD",
};

const FEEDTYPE_COLOURS = {
  warning: "#FFC107", "watch-and-act": "#FF6D00", "emergency-warning": "#D50000",
};

function buildMapHtml(incidents, cfg) {
  const markers = incidents.map((inc) => {
    const colour = FEEDTYPE_COLOURS[inc.feedType] || GROUP_COLOURS[inc.group] || GROUP_COLOURS.other;
    const label = (inc.eventType || inc.category1 || inc.title || "Incident").replace(/'/g, "\\'");
    const detail = (inc.location || "").replace(/'/g, "\\'");
    const dist = inc.distance;
    return { lat: inc.lat, lon: inc.lon, colour, label, detail, dist, feedType: inc.feedType, resources: inc.resources };
  });

  const dataJson = JSON.stringify({ home: { lat: cfg.HOME_LAT, lon: cfg.HOME_LON }, markers, zoom: cfg.MAP_ZOOM })
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

  const isLight = cfg.MAP_THEME === "light";
  const tileUrl = isLight
    ? 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
  const mapBg = isLight ? '#f2efe9' : '#1e1e20';
  const attrBg = isLight ? 'rgba(255,255,255,0.8)' : 'rgba(30,30,32,0.7)';
  const attrColor = isLight ? '#666' : '#8E8E93';
  const attrLink = isLight ? '#555' : '#AAAAAA';
  const zoomBg = isLight ? 'rgba(255,255,255,0.9)' : 'rgba(30,30,32,0.85)';
  const zoomBgHover = isLight ? 'rgba(240,240,240,0.95)' : 'rgba(50,50,54,0.9)';
  const zoomColor = isLight ? '#333' : '#E0E0E0';
  const zoomBorder = isLight ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.1)';
  const labelShadow = isLight
    ? 'text-shadow:0 1px 2px rgba(255,255,255,0.9);'
    : 'text-shadow:0 1px 3px rgba(0,0,0,0.8);';
  const radiusStroke = isLight ? 'rgba(74,144,217,0.35)' : 'rgba(74,144,217,0.25)';
  const radiusFill = isLight ? 'rgba(74,144,217,0.06)' : 'rgba(74,144,217,0.04)';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: transparent; }
  #map {
    width: 100%;
    height: 100%;
    border-radius: 10px;
    overflow: hidden;
    background: ${mapBg};
  }
  .leaflet-control-attribution {
    font-size: 9px !important;
    background: ${attrBg} !important;
    color: ${attrColor} !important;
    border-radius: 4px 0 0 0 !important;
  }
  .leaflet-control-attribution a { color: ${attrLink} !important; }
  .leaflet-control-zoom a {
    background: ${zoomBg} !important;
    color: ${zoomColor} !important;
    border-color: ${zoomBorder} !important;
  }
  .leaflet-control-zoom a:hover {
    background: ${zoomBgHover} !important;
  }
  .ve-popup {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    font-size: 12px;
    line-height: 1.4;
  }
  .ve-popup-title { font-weight: 600; margin-bottom: 2px; }
  .ve-popup-detail { color: #666; font-size: 11px; }
  .ve-popup-dist { color: #999; font-size: 10px; margin-top: 2px; }
  .leaflet-popup-content-wrapper {
    border-radius: 8px !important;
    box-shadow: 0 3px 14px rgba(0,0,0,0.3) !important;
  }
  .leaflet-popup-tip { box-shadow: 0 3px 14px rgba(0,0,0,0.2) !important; }
</style>
</head>
<body>
<div id="map"></div>
<script>
(function() {
  var d = ${dataJson};
  var map = L.map('map', {
    center: [d.home.lat, d.home.lon],
    zoom: d.zoom,
    zoomControl: true,
    attributionControl: true,
  });

  L.tileLayer('${tileUrl}', {
    attribution: '\\u00a9 <a href="https://www.openstreetmap.org/copyright">OSM</a>, \\u00a9 <a href="https://carto.com/">CARTO</a>' + (${cfg.SHOW_EARTHQUAKES ? 'true' : 'false'} ? ', quakes \u00a9 Geoscience Australia' : ''),
    subdomains: 'abcd',
    maxZoom: 19
  }).addTo(map);

  // Home marker — blue ring with label
  L.circleMarker([d.home.lat, d.home.lon], {
    radius: 12,
    color: '#4A90D9',
    fillColor: 'rgba(74,144,217,0.15)',
    fillOpacity: 1,
    weight: 2,
  }).addTo(map);

  L.marker([d.home.lat, d.home.lon], {
    icon: L.divIcon({
      className: '',
      html: '<div style="color:#4A90D9;font-size:14px;font-weight:700;font-family:-apple-system,sans-serif;${labelShadow}white-space:nowrap;">A</div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    }),
    interactive: false,
  }).addTo(map);

  // Radius circle — dashed boundary
  L.circle([d.home.lat, d.home.lon], {
    radius: ${cfg.RADIUS_KM} * 1000,
    color: '${radiusStroke}',
    fillColor: '${radiusFill}',
    fillOpacity: 1,
    weight: 1,
    dashArray: '6 4',
  }).addTo(map);

  // Incident markers — store references for panTo
  var markerRefs = [];
  d.markers.forEach(function(m, idx) {
    var isWarning = m.feedType && m.feedType !== 'incident';
    var radius = isWarning ? 10 : 7;
    var weight = isWarning ? 2.5 : 2;

    var cm = L.circleMarker([m.lat, m.lon], {
      radius: radius,
      color: m.colour,
      fillColor: m.colour,
      fillOpacity: 0.3,
      weight: weight,
    }).addTo(map).bindPopup(
      '<div class="ve-popup">' +
        '<div class="ve-popup-title" style="color:' + m.colour + '">' + m.label + '</div>' +
        (m.detail ? '<div class="ve-popup-detail">' + m.detail + '</div>' : '') +
        '<div class="ve-popup-dist">' + m.dist + ' km away' + (m.resources > 0 ? ' \\u00b7 ' + m.resources + ' appliance' + (m.resources !== 1 ? 's' : '') : '') + '</div>' +
      '</div>'
    );
    markerRefs.push(cm);
  });

  // Listen for panTo messages from parent widget
  var pickerEnabled = false;
  var pickerMarker = null;

  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'panTo') {
      map.setView([e.data.lat, e.data.lon], 13, { animate: true });
      if (typeof e.data.idx === 'number' && markerRefs[e.data.idx]) {
        markerRefs[e.data.idx].openPopup();
      }
    }
    if (e.data && e.data.type === 'resetView') {
      map.closePopup();
      if (d.markers.length > 0) {
        var pts = [[d.home.lat, d.home.lon]];
        d.markers.forEach(function(m2) { pts.push([m2.lat, m2.lon]); });
        map.fitBounds(pts, { padding: [30, 30], maxZoom: 13 });
      } else {
        map.setView([d.home.lat, d.home.lon], d.zoom, { animate: true });
      }
    }
    if (e.data && e.data.type === 'enablePicker') {
      pickerEnabled = true;
      map.getContainer().style.cursor = 'crosshair';
    }
    if (e.data && e.data.type === 'disablePicker') {
      pickerEnabled = false;
      map.getContainer().style.cursor = '';
      if (pickerMarker) { map.removeLayer(pickerMarker); pickerMarker = null; }
    }
  });

  // Click on map to pick location — sends coords to parent
  map.on('click', function(ev) {
    if (!pickerEnabled) return;
    var lat = Math.round(ev.latlng.lat * 1000000) / 1000000;
    var lon = Math.round(ev.latlng.lng * 1000000) / 1000000;
    if (pickerMarker) { map.removeLayer(pickerMarker); pickerMarker = null; }
    pickerMarker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: '',
        html: '<div style="color:#FF4081;font-size:22px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,0.6);line-height:1;">\\u2716</div>',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      }),
    }).addTo(map);
    window.parent.postMessage({ type: 'locationPicked', lat: lat, lon: lon }, '*');
  });

  // Auto-fit bounds if incidents exist
  if (d.markers.length > 0) {
    var points = [[d.home.lat, d.home.lon]];
    d.markers.forEach(function(m) { points.push([m.lat, m.lon]); });
    map.fitBounds(points, { padding: [30, 30], maxZoom: 13 });
  }
})();
<\/script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────
// ▸ RENDERING
// ─────────────────────────────────────────────────────────────

const GROUP_META = {
  fire:             { label: "Fire",      emoji: "\uD83D\uDD25", colour: "#E53935" },
  flood:            { label: "Flood",     emoji: "\uD83C\uDF0A", colour: "#42A5F5" },
  storm_weather:    { label: "Storm",     emoji: "\u26C8\uFE0F", colour: "#AB47BC" },
  transport:        { label: "Transport", emoji: "\uD83D\uDE97", colour: "#FB8C00" },
  hazmat_health:    { label: "Hazmat",    emoji: "\u2623\uFE0F", colour: "#66BB6A" },
  outages_closures: { label: "Outages",   emoji: "\u26A1",       colour: "#78909C" },
};

const WARNING_BADGE = {
  none:              { label: "All Clear",         emoji: "\u2705", colour: "#4CAF50", bg: "rgba(76,175,80,0.15)" },
  active:            { label: "Active",            emoji: "\u2139\uFE0F", colour: "#90A4AE", bg: "rgba(144,164,174,0.15)" },
  advice:            { label: "Advice",            emoji: "\uD83D\uDFE1", colour: "#FFC107", bg: "rgba(255,193,7,0.15)" },
  watch_and_act:     { label: "Watch & Act",       emoji: "\uD83D\uDFE0", colour: "#FF6D00", bg: "rgba(255,109,0,0.15)" },
  emergency_warning: { label: "Emergency Warning", emoji: "\uD83D\uDD34", colour: "#D50000", bg: "rgba(213,0,0,0.20)" },
};

const FEEDTYPE_DOT = {
  incident:            "#78909C",
  warning:             "#FFC107",
  "watch-and-act":     "#FF6D00",
  "emergency-warning": "#D50000",
};

const FEEDTYPE_LABEL = {
  incident: "Incident",
  warning: "Advice",
  "watch-and-act": "Watch & Act",
  "emergency-warning": "Emergency Warning",
};

export const render = ({ output }) => {
  // Parse envelope: {"config": {...}, "feed": {...}}
  let feedData = output;
  let cfg = { ...DEFAULTS };
  let quakeData = null;
  try {
    const envelope = JSON.parse(output);
    if (envelope.config) cfg = { ...DEFAULTS, ...envelope.config };
    feedData = envelope.feed || {};
    quakeData = envelope.quakes || null;
  } catch (e) {
    // Fallback: treat entire output as feed (first run before config exists)
    try { feedData = JSON.parse(output); } catch (e2) { feedData = { error: true }; }
  }

  const { error, incidents, feedSource } = parseFeed(feedData, cfg);
  if (!error) {
    incidents.push(...parseQuakes(quakeData, cfg));
    incidents.sort((a, b) => a.distance - b.distance);
  }
  const now = new Date();
  const updated = now.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
  const radio = pickRadio(cfg);

  // Compute group counts
  const groupCounts = {};
  for (const key of Object.keys(GROUP_META)) groupCounts[key] = 0;
  for (const inc of incidents) {
    if (groupCounts[inc.group] !== undefined) groupCounts[inc.group]++;
  }

  // Highest warning level
  let maxWarn = 0;
  let maxWarnName = "none";
  for (const inc of incidents) {
    if (inc.warningLevel && (WARNING_PRIORITY[inc.warningLevel] || 0) > maxWarn) {
      maxWarn = WARNING_PRIORITY[inc.warningLevel];
      maxWarnName = inc.warningLevel;
    }
  }
  const badgeKey = (maxWarnName === "none" && incidents.length > 0) ? "active" : maxWarnName;
  const badge = WARNING_BADGE[badgeKey] || WARNING_BADGE.none;

  // Nearest
  const nearest = incidents.length > 0 ? incidents[0] : null;

  // Shown incidents
  const shown = incidents.slice(0, cfg.MAX_INCIDENTS);
  const remaining = incidents.length - shown.length;

  // Map HTML
  const showMap = cfg.SHOW_MAP === "auto" ? incidents.length > 0 : !!cfg.SHOW_MAP;

  // Pan map to a specific incident, or reset if clicking the same one again
  const panToIncident = (lat, lon, idx) => {
    const iframe = document.querySelector('.ve-map-iframe');
    if (!iframe || !iframe.contentWindow) return;

    if (_lastClickedIdx === idx) {
      iframe.contentWindow.postMessage({ type: 'resetView' }, '*');
      _lastClickedIdx = null;
    } else {
      iframe.contentWindow.postMessage({ type: 'panTo', lat, lon, idx }, '*');
      _lastClickedIdx = idx;
    }
  };

  const resetMapView = () => {
    const iframe = document.querySelector('.ve-map-iframe');
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'resetView' }, '*');
    }
    _lastClickedIdx = null;
  };

  // Auto-collapse when clear, auto-expand when incidents.
  // Manual toggle can override, but resets when state changes.
  const autoCollapsed = incidents.length === 0;
  if (_prevIncidentCount !== undefined && _prevIncidentCount !== incidents.length) {
    _collapsed = autoCollapsed;
  }
  if (_prevIncidentCount === undefined) {
    _collapsed = autoCollapsed;
  }
  _prevIncidentCount = incidents.length;

  // Toggle collapsed state — manual override until next state change
  const toggleCollapsed = (e) => {
    _collapsed = !_collapsed;
    const widget = e.target.closest('.ve-widget');
    if (widget) {
      widget.classList.toggle('ve-collapsed', _collapsed);
      // Map has inline style so CSS !important won't override — toggle via DOM
      const mapContainer = widget.querySelector('.ve-map-container');
      if (mapContainer) {
        mapContainer.style.display = _collapsed ? 'none' : (showMap ? '' : 'none');
      }
    }
  };

  // Settings panel
  const toggleSettings = (e) => {
    e.stopPropagation();
    _settingsOpen = !_settingsOpen;
    const widget = e.target.closest('.ve-widget');
    if (widget) {
      // If collapsed, expand first so settings and map are visible
      if (_settingsOpen && _collapsed) {
        _collapsed = false;
        widget.classList.remove('ve-collapsed');
      }

      const panel = widget.querySelector('.ve-settings');
      if (panel) panel.style.display = _settingsOpen ? 'block' : 'none';

      // Toggle gear icon state
      const gear = widget.querySelector('.ve-settings-btn');
      if (gear) gear.classList.toggle('ve-settings-btn-active', _settingsOpen);

      // Hide/show chips, list, footer to free space for settings
      widget.querySelectorAll('.ve-chips, .ve-list, .ve-footer').forEach((el) => {
        el.style.display = _settingsOpen ? 'none' : '';
      });

      // Show/hide map via DOM (JSX conditional won't re-evaluate until refresh)
      const mapContainer = widget.querySelector('.ve-map-container');
      if (mapContainer) {
        if (_settingsOpen) {
          mapContainer.style.display = 'block';
          const iframe = mapContainer.querySelector('.ve-map-iframe');
          if (iframe) iframe.style.height = Math.min(cfg.MAP_HEIGHT, 180) + 'px';
        } else {
          // Restore: hide if no incidents and SHOW_MAP is auto
          const shouldHideMap = cfg.SHOW_MAP === "auto" && incidents.length === 0;
          mapContainer.style.display = shouldHideMap ? 'none' : '';
          const iframe = mapContainer.querySelector('.ve-map-iframe');
          if (iframe) iframe.style.height = cfg.MAP_HEIGHT + 'px';
          // Re-collapse if no incidents
          if (incidents.length === 0) {
            _collapsed = true;
            widget.classList.add('ve-collapsed');
          }
        }
      }
    }
    // Enable/disable map picker
    const iframe = document.querySelector('.ve-map-iframe');
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: _settingsOpen ? 'enablePicker' : 'disablePicker' }, '*');
    }
  };

  // Listen for location picked from map click
  if (!window._vePickerListening) {
    window._vePickerListening = true;
    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'locationPicked') {
        const latInput = document.querySelector('#ve-cfg-lat');
        const lonInput = document.querySelector('#ve-cfg-lon');
        if (latInput) latInput.value = e.data.lat;
        if (lonInput) lonInput.value = e.data.lon;
      }
    });
  }

  const saveSettings = (e) => {
    e.stopPropagation();
    const widget = e.target.closest('.ve-widget');
    if (!widget) return;
    const val = (id) => widget.querySelector(`#ve-cfg-${id}`)?.value;
    const chk = (id) => widget.querySelector(`#ve-cfg-${id}`)?.checked;

    const newCfg = {
      HOME_LAT: parseFloat(val('lat')) || DEFAULTS.HOME_LAT,
      HOME_LON: parseFloat(val('lon')) || DEFAULTS.HOME_LON,
      RADIUS_KM: parseInt(val('radius')) || DEFAULTS.RADIUS_KM,
      ZONE_NAME: val('zone') || DEFAULTS.ZONE_NAME,
      MAX_INCIDENTS: parseInt(val('max')) || DEFAULTS.MAX_INCIDENTS,
      MAP_HEIGHT: parseInt(val('height')) || DEFAULTS.MAP_HEIGHT,
      MAP_ZOOM: parseInt(val('zoom')) || DEFAULTS.MAP_ZOOM,
      MAP_THEME: val('theme') || DEFAULTS.MAP_THEME,
      SHOW_MAP: val('showmap') === "auto" ? "auto" : val('showmap') === "true",
      EXCLUDE_BURN_AREA: chk('burn'),
      HIDE_WHEN_CLEAR: chk('hide'),
      SHOW_EARTHQUAKES: chk('quakes'),
      QUAKE_MIN_MAG: isNaN(parseFloat(val('quakemag'))) ? DEFAULTS.QUAKE_MIN_MAG : parseFloat(val('quakemag')),
      QUAKE_MAX_AGE_H: cfg.QUAKE_MAX_AGE_H,
    };

    const json = JSON.stringify(newCfg, null, 2);
    run(`cat > ~/.vicemergency-config.json << 'VICEOF'\n${json}\nVICEOF`).then(() => {
      _settingsOpen = false;
      const panel = widget.querySelector('.ve-settings');
      if (panel) panel.style.display = 'none';
      // Reset gear icon
      const gear = widget.querySelector('.ve-settings-btn');
      if (gear) gear.classList.remove('ve-settings-btn-active');
      // Restore hidden sections
      widget.querySelectorAll('.ve-chips, .ve-list, .ve-footer').forEach((el) => {
        el.style.display = '';
      });
      // Restore map: hide if no incidents and auto mode
      const mapContainer = widget.querySelector('.ve-map-container');
      if (mapContainer) {
        const shouldHideMap = cfg.SHOW_MAP === "auto" && incidents.length === 0;
        mapContainer.style.display = shouldHideMap ? 'none' : '';
        const mapFrame = mapContainer.querySelector('.ve-map-iframe');
        if (mapFrame) mapFrame.style.height = cfg.MAP_HEIGHT + 'px';
      }
      // Re-collapse if no incidents
      if (incidents.length === 0) {
        _collapsed = true;
        widget.classList.add('ve-collapsed');
      }
      // Disable picker
      const iframe = document.querySelector('.ve-map-iframe');
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage({ type: 'disablePicker' }, '*');
      }
    });
  };

  if (error) {
    return (
      <div className="ve-widget">
        <div className="ve-error">
          <span>{"\u26A0\uFE0F"} {error}</span>
          <span className="ve-updated">Last attempt: {updated}</span>
        </div>
      </div>
    );
  }

  if (cfg.HIDE_WHEN_CLEAR && incidents.length === 0) {
    return <div className="ve-hidden" />;
  }

  return (
    <div className={`ve-widget ${_collapsed ? "ve-collapsed" : ""}`}>
      {/* Header */}
      <div className="ve-header">
        <div className="ve-title-row">
          <div className="ve-title-group">
            <span className="ve-title" onClick={resetMapView}>{cfg.ZONE_NAME}</span>
            <span className="ve-count">
              {incidents.length === 0
                ? "No active incidents"
                : `${incidents.length} active incident${incidents.length !== 1 ? "s" : ""}`}
              <span className="ve-feed-dot" style={{ background: feedSource === "geojson" ? "#4CAF50" : "#FFC107" }} title={`Feed: ${feedSource}`}></span>
            </span>
          </div>
          <div className="ve-header-actions">
            <span className={`ve-settings-btn ${_settingsOpen ? "ve-settings-btn-active" : ""}`} onClick={toggleSettings}>{"\u2699\uFE0F"}</span>
            <span className="ve-toggle" onClick={toggleCollapsed}>
              {_collapsed ? "\u25BC" : "\u25B2"}
            </span>
            <div className="ve-badge" style={{ color: badge.colour, background: badge.bg }}>
              <span className="ve-badge-emoji">{badge.emoji}</span>
              <span>{badge.label}</span>
            </div>
          </div>
        </div>

        {nearest && (
          <div className="ve-nearest" onClick={() => panToIncident(nearest.lat, nearest.lon, 0)}>
            <span className="ve-nearest-icon">{"\uD83D\uDCCD"}</span>
            <span>
              Nearest: <strong>{nearest.distance} km {nearest.bearing}</strong>
            </span>
            <span className="ve-nearest-detail">
              {nearest.eventType || nearest.category1 || nearest.title}
              {nearest.location ? ` \u2014 ${nearest.location}` : ""}
            </span>
          </div>
        )}
      </div>

      {/* Category chips */}
      <div className="ve-chips">
        {Object.entries(GROUP_META).map(([key, meta]) => {
          const count = groupCounts[key] || 0;
          const active = count > 0;
          return (
            <div key={key} className={`ve-chip ${active ? "ve-chip-active" : ""}`}
                 style={active ? { borderColor: meta.colour, color: meta.colour } : {}}>
              <span className="ve-chip-emoji">{meta.emoji}</span>
              <span className="ve-chip-count">{count}</span>
              <span className="ve-chip-label">{meta.label}</span>
            </div>
          );
        })}
      </div>

      {/* Incident list */}
      <div className="ve-list">
        {incidents.length === 0 && (
          <div className="ve-empty">{"\u2705"} No incidents in your area</div>
        )}

        {shown.map((inc, idx) => {
          const gm = GROUP_META[inc.group] || {};
          const dot = FEEDTYPE_DOT[inc.feedType] || FEEDTYPE_DOT.incident;
          const isWarning = inc.feedType && inc.feedType !== "incident";
          const validTitle = inc.title && inc.title !== "Undefined" && inc.title !== "undefined" ? inc.title : "";
          const displayTitle = isWarning
            ? (inc.location || inc.eventType || validTitle || "Warning")
            : (inc.location || validTitle || inc.category1 || "Unknown");
          const displayCat = inc.eventType || inc.category1 || "";
          const displayStatus = isWarning
            ? (FEEDTYPE_LABEL[inc.feedType] || "")
            : (inc.status || "");

          return (
            <div key={inc.id} className="ve-incident" onClick={() => panToIncident(inc.lat, inc.lon, idx)}>
              <div className="ve-dot" style={{ background: dot }} />
              <div className="ve-incident-body">
                <div className="ve-incident-title">{displayTitle}</div>
                <div className="ve-incident-meta">
                  <span style={{ color: gm.colour || "#999" }}>{displayCat}</span>
                  {displayStatus && <span className="ve-incident-status">{displayStatus}</span>}
                </div>
              </div>
              <div className="ve-incident-right">
                {inc.resources > 0 && <span className="ve-incident-resources">{"\uD83D\uDE92"} {inc.resources}</span>}
                <span className="ve-incident-dist">{inc.distance} km</span>
              </div>
            </div>
          );
        })}

        {remaining > 0 && (
          <div className="ve-more">+ {remaining} more</div>
        )}
      </div>

      {/* Map — always in DOM, visibility managed by toggleSettings and inline style */}
      <div className="ve-map-container" style={{ display: showMap ? 'block' : 'none' }}>
        <iframe
          srcDoc={buildMapHtml(incidents, cfg)}
          className="ve-map-iframe"
          style={{ height: `${cfg.MAP_HEIGHT}px`, background: cfg.MAP_THEME === "light" ? "#f2efe9" : "#1e1e20" }}
          sandbox="allow-scripts"
          scrolling="no"
        />
      </div>

      {/* Settings panel */}
      <div className="ve-settings" style={{ display: _settingsOpen ? "block" : "none" }}>
        <div className="ve-settings-title">Settings</div>
        <div className="ve-settings-hint">{"\uD83D\uDCCD"} Click the map to set your location</div>
        <div className="ve-settings-actions">
          <span className="ve-settings-save" onClick={saveSettings}>Save</span>
          <span className="ve-settings-cancel" onClick={toggleSettings}>Cancel</span>
        </div>
        <div className="ve-settings-scroll">
        <div className="ve-settings-grid">
          <label>Zone name</label>
          <input id="ve-cfg-zone" defaultValue={cfg.ZONE_NAME} />

          <label>Latitude</label>
          <input id="ve-cfg-lat" type="number" step="0.001" defaultValue={cfg.HOME_LAT} />

          <label>Longitude</label>
          <input id="ve-cfg-lon" type="number" step="0.001" defaultValue={cfg.HOME_LON} />

          <label>Radius (km)</label>
          <input id="ve-cfg-radius" type="number" min="1" max="500" defaultValue={cfg.RADIUS_KM} />

          <label>Max incidents</label>
          <input id="ve-cfg-max" type="number" min="1" max="50" defaultValue={cfg.MAX_INCIDENTS} />

          <label>Map height (px)</label>
          <input id="ve-cfg-height" type="number" min="100" max="600" defaultValue={cfg.MAP_HEIGHT} />

          <label>Map zoom</label>
          <input id="ve-cfg-zoom" type="number" min="5" max="18" defaultValue={cfg.MAP_ZOOM} />

          <label>Map theme</label>
          <select id="ve-cfg-theme" defaultValue={cfg.MAP_THEME}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>

          <label>Show map</label>
          <select id="ve-cfg-showmap" defaultValue={String(cfg.SHOW_MAP)}>
            <option value="auto">Auto (when incidents)</option>
            <option value="true">Always</option>
            <option value="false">Never</option>
          </select>

          <label>Exclude burn areas</label>
          <input id="ve-cfg-burn" type="checkbox" defaultChecked={cfg.EXCLUDE_BURN_AREA} />

          <label>Hide when clear</label>
          <input id="ve-cfg-hide" type="checkbox" defaultChecked={cfg.HIDE_WHEN_CLEAR} />

          <label>Show earthquakes</label>
          <input id="ve-cfg-quakes" type="checkbox" defaultChecked={cfg.SHOW_EARTHQUAKES} />

          <label>Min quake magnitude</label>
          <input id="ve-cfg-quakemag" type="number" step="0.1" min="0" max="9" defaultValue={cfg.QUAKE_MIN_MAG} />
        </div>
        </div>
      </div>

      {/* Footer */}
      <div className="ve-footer">
        <div className="ve-footer-links">
          <span className="ve-footer-link" onClick={() => run("open 'https://emergency.vic.gov.au/respond/'")}>
            {"\uD83D\uDD17"} VicEmergency
          </span>
          <span className="ve-footer-link" title={`${radio.abc.name} ${radio.abc.freq} — official emergency broadcaster`}
                onClick={() => run(`open -a "QuickTime Player" '${radio.abc.stream}' || open '${radio.abc.url}'`)}>
            {"\uD83D\uDCFB"} {radio.abc.name} {radio.abc.freq}
          </span>
          {radio.local.map((r) => (
            <span key={r.name} className={r.stream || r.url ? "ve-footer-link" : "ve-footer-text"}
                  title={`${r.name} ${r.freq} — local emergency broadcaster`}
                  onClick={r.stream
                    ? () => run(`open -a "QuickTime Player" '${r.stream}'` + (r.url ? ` || open '${r.url}'` : ""))
                    : r.url ? () => run(`open '${r.url}'`) : undefined}>
              {r.name} {r.freq}
            </span>
          ))}
        </div>
        <span className="ve-updated">Updated {updated}</span>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// ▸ STYLES
// ─────────────────────────────────────────────────────────────

export const className = `
  ${WIDGET_POSITION.top ? `top: ${WIDGET_POSITION.top};` : ""}
  ${WIDGET_POSITION.bottom ? `bottom: ${WIDGET_POSITION.bottom};` : ""}
  ${WIDGET_POSITION.left ? `left: ${WIDGET_POSITION.left};` : ""}
  ${WIDGET_POSITION.right ? `right: ${WIDGET_POSITION.right};` : ""}
  z-index: 10;

  * { box-sizing: border-box; margin: 0; padding: 0; }

  .ve-hidden { display: none; }

  .ve-widget {
    width: 380px;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
    font-size: 13px;
    color: #E0E0E0;
    background: rgba(30, 30, 32, 0.88);
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 16px;
    padding: 16px;
    box-shadow:
      0 8px 32px rgba(0,0,0,0.45),
      0 1px 3px rgba(0,0,0,0.25),
      inset 0 1px 0 rgba(255,255,255,0.04);
  }

  .ve-error {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: #FF6B6B;
    font-size: 12px;
  }

  .ve-header { margin-bottom: 12px; }

  .ve-title-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }

  .ve-title-group {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .ve-title {
    font-size: 17px;
    font-weight: 700;
    color: #FFFFFF;
    letter-spacing: -0.2px;
    cursor: pointer;
    transition: color 0.15s;
  }

  .ve-title:hover {
    color: #4A90D9;
  }

  .ve-count { font-size: 12px; color: #8E8E93; }

  .ve-feed-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    margin-left: 5px;
    vertical-align: middle;
  }

  .ve-header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .ve-toggle {
    font-size: 10px;
    color: #636366;
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 4px;
    transition: color 0.15s, background 0.15s;
    user-select: none;
    line-height: 1;
  }

  .ve-toggle:hover {
    color: #E0E0E0;
    background: rgba(255,255,255,0.08);
  }

  /* Collapsed state — hide everything below title row */
  .ve-collapsed .ve-nearest,
  .ve-collapsed .ve-chips,
  .ve-collapsed .ve-list,
  .ve-collapsed .ve-map-container,
  .ve-collapsed .ve-footer {
    display: none;
  }

  .ve-collapsed {
    padding-bottom: 12px;
  }

  .ve-collapsed .ve-header {
    margin-bottom: 0;
  }

  .ve-badge {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }

  .ve-badge-emoji { font-size: 11px; }

  .ve-nearest {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 10px;
    padding: 7px 10px;
    border-radius: 8px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.06);
    font-size: 12px;
    cursor: pointer;
    transition: background 0.15s;
  }

  .ve-nearest:hover {
    background: rgba(255,255,255,0.08);
  }

  .ve-nearest-icon { font-size: 13px; flex-shrink: 0; }
  .ve-nearest strong { color: #FFFFFF; }

  .ve-nearest-detail {
    margin-left: auto;
    color: #8E8E93;
    text-align: right;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 150px;
  }

  .ve-chips {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin-bottom: 12px;
  }

  .ve-chip {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    border-radius: 8px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.06);
    color: #636366;
    font-size: 11px;
    transition: all 0.2s ease;
  }

  .ve-chip-active {
    background: rgba(255,255,255,0.06);
    border-color: currentColor;
  }

  .ve-chip-emoji { font-size: 12px; }
  .ve-chip-count { font-weight: 700; font-size: 13px; min-width: 10px; }
  .ve-chip-label { font-size: 10px; opacity: 0.8; }

  .ve-list { margin-bottom: 10px; }

  .ve-empty {
    text-align: center;
    padding: 16px 0;
    font-size: 12px;
    color: #4CAF50;
  }

  .ve-incident {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 4px;
    margin: 0 -4px;
    border-bottom: 1px solid rgba(255,255,255,0.05);
    cursor: pointer;
    border-radius: 6px;
    transition: background 0.15s;
  }

  .ve-incident:hover {
    background: rgba(255,255,255,0.06);
  }

  .ve-incident:last-child { border-bottom: none; }

  .ve-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-top: 4px;
    flex-shrink: 0;
  }

  .ve-incident-body { flex: 1; min-width: 0; }

  .ve-incident-title {
    font-size: 12px;
    font-weight: 500;
    color: #E0E0E0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ve-incident-meta {
    display: flex;
    gap: 8px;
    font-size: 11px;
    margin-top: 1px;
  }

  .ve-incident-meta span:first-child { font-weight: 600; }
  .ve-incident-status { color: #636366; }

  .ve-incident-right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    flex-shrink: 0;
    margin-top: 2px;
  }

  .ve-incident-dist {
    font-size: 11px;
    font-weight: 600;
    color: #8E8E93;
    white-space: nowrap;
  }

  .ve-incident-resources {
    font-size: 10px;
    color: #FB8C00;
    white-space: nowrap;
  }

  .ve-more {
    text-align: center;
    padding: 6px 0;
    font-size: 11px;
    color: #636366;
  }

  /* ── Settings panel ── */

  .ve-settings-btn {
    font-size: 13px;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 4px;
    transition: background 0.15s;
    user-select: none;
    line-height: 1;
  }

  .ve-settings-btn:hover {
    background: rgba(255,255,255,0.08);
  }

  .ve-settings-btn-active {
    animation: ve-gear-pulse 1.5s ease-in-out infinite;
  }

  @keyframes ve-gear-pulse {
    0%, 100% { background: rgba(255,193,7,0.15); }
    50% { background: rgba(255,193,7,0.35); }
  }

  .ve-settings {
    margin-bottom: 10px;
    padding: 12px;
    border-radius: 10px;
    background: rgba(36, 36, 38, 0.96);
    border: 1px solid rgba(255,255,255,0.08);
  }

  .ve-settings-scroll {
    max-height: 140px;
    overflow-y: auto;
  }

  .ve-settings-title {
    font-size: 12px;
    font-weight: 600;
    color: #FFFFFF;
    margin-bottom: 4px;
  }

  .ve-settings-hint {
    font-size: 10px;
    color: #FF4081;
    margin-bottom: 10px;
  }

  .ve-settings-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 10px;
    align-items: center;
  }

  .ve-settings-grid label {
    font-size: 11px;
    color: #8E8E93;
  }

  .ve-settings-grid input,
  .ve-settings-grid select {
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.1);
    background: rgba(255,255,255,0.06);
    color: #E0E0E0;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    width: 100%;
    box-sizing: border-box;
  }

  .ve-settings-grid input:focus,
  .ve-settings-grid select:focus {
    outline: none;
    border-color: #4A90D9;
  }

  .ve-settings-grid input[type="checkbox"] {
    width: auto;
    cursor: pointer;
  }

  .ve-settings-grid select { cursor: pointer; }

  .ve-settings-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-bottom: 10px;
  }

  .ve-settings-save,
  .ve-settings-cancel {
    font-size: 11px;
    font-weight: 600;
    padding: 4px 14px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.15s;
    user-select: none;
  }

  .ve-settings-save {
    background: #4A90D9;
    color: #FFFFFF;
  }

  .ve-settings-save:hover { background: #5AA0E9; }

  .ve-settings-cancel {
    color: #8E8E93;
    background: rgba(255,255,255,0.06);
  }

  .ve-settings-cancel:hover { background: rgba(255,255,255,0.10); }

  .ve-collapsed .ve-settings { display: none !important; }

  .ve-map-container {
    margin-bottom: 10px;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,0.06);
  }

  .ve-map-iframe {
    width: 100%;
    border: none;
    display: block;
    border-radius: 10px;
  }

  .ve-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 8px;
    border-top: 1px solid rgba(255,255,255,0.06);
    font-size: 11px;
    color: #636366;
  }

  .ve-updated {
    font-size: 10px;
    color: #48484A;
  }

  .ve-footer-links {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
  }

  .ve-footer-text {
    color: #8E8E93;
    font-size: 11px;
  }

  .ve-footer-link {
    color: #8E8E93;
    text-decoration: none;
    font-size: 11px;
    transition: color 0.15s;
    cursor: pointer;
  }

  .ve-footer-link:hover {
    color: #E0E0E0;
  }
`;
