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
 * @version 1.8.0
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
  FIRE_DISTRICT: "auto", // "auto" = from home location, or a district name e.g. "North East"
  ALERTS: true,              // macOS notification for new/escalated warnings and fire bans
  ALERT_LEVEL: "watch_and_act", // lowest warning level that alerts: "advice" | "watch_and_act" | "emergency_warning"
  ALERT_SOUND: true,
};

const ALERT_STATE_PATH = "$HOME/.vicemergency-alerted.json";

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
  echo ',"alerted":';
  cat ${ALERT_STATE_PATH} 2>/dev/null || echo 'null';
  echo '}'
`;

import { run } from "uebersicht";

export const init = (dispatch) => {};

// Persistent state (survives re-renders, resets on widget reload)
let _collapsed = false;
let _prevIncidentCount = undefined;
let _lastClickedIdx = null;
let _settingsOpen = false;
let _groupFilter = null;    // category chip filter (group key) — survives refreshes until cleared
let _alertedSession = {};   // alerts already sent this session (backs up the state file)

// ─────────────────────────────────────────────────────────────
// ▸ DATA LAYER — ported from vicemergency-ha parser
// ─────────────────────────────────────────────────────────────

const CATEGORY_GROUPS = {
  "Fire":"fire","Bushfire":"fire","Planned Burn":"fire","Burn Area":"fire","Burn Advice":"fire",
  "Flood":"flood","Flooding":"flood","Riverine Flood":"flood","Flash Flood":"flood","Coastal Flood":"flood","Dam Failure":"flood",
  "Storm":"storm_weather","Severe Storm":"storm_weather","Severe Weather":"storm_weather",
  "Severe Thunderstorm":"storm_weather","Damaging Winds":"storm_weather","Tornado/Cyclone":"storm_weather",
  "Met":"storm_weather","Earthquake":"quake","Tsunami":"storm_weather","Landslide":"storm_weather",
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

// All polygon outer rings in a geometry, as [[lon,lat], ...]
function extractRings(geometry) {
  if (!geometry) return [];
  const t = geometry.type;
  if (t === "GeometryCollection") return (geometry.geometries || []).flatMap(extractRings);
  if (t === "Polygon") return geometry.coordinates && geometry.coordinates[0] ? [geometry.coordinates[0]] : [];
  if (t === "MultiPolygon") return (geometry.coordinates || []).map((poly) => poly[0]).filter(Boolean);
  return [];
}

// Ray-casting point-in-polygon; ring is [[lon,lat], ...]
function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// Thin a ring to at most maxPts points for drawing; returns [[lat,lon], ...]
function thinRing(ring, maxPts) {
  const step = Math.max(1, Math.ceil(ring.length / maxPts));
  const out = [];
  for (let i = 0; i < ring.length; i += step) out.push([ring[i][1], ring[i][0]]);
  return out;
}

// Incident status → how prominently it is drawn (active, controlled, finished)
const STATUS_ACTIVE = /respond|going|not yet under control|request for assistance|warning|en route|on scene/i;
const STATUS_FINISHED = /^(safe|patrolled|complete|completed|minor|closed)$/i;
function statusClass(status) {
  if (STATUS_FINISHED.test(status || "")) return "finished";
  if (STATUS_ACTIVE.test(status || "")) return "active";
  return "controlled";
}

// "10:42 am" today, otherwise "24 Oct, 5:23 pm" (Melbourne time)
function whenText(iso) {
  const t = iso ? new Date(iso) : null;
  if (!t || isNaN(t)) return "";
  const tz = { timeZone: "Australia/Melbourne" };
  const time = t.toLocaleTimeString("en-AU", { ...tz, hour: "numeric", minute: "2-digit" });
  const sameDay = t.toLocaleDateString("en-CA", tz) === new Date().toLocaleDateString("en-CA", tz);
  return sameDay ? time : `${t.toLocaleDateString("en-AU", { ...tz, day: "numeric", month: "short" })}, ${time}`;
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<\/(p|div|li|br)>|<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&rdquo;|&ldquo;/g, '"')
    .replace(/\s+/g, " ").trim();
}

// Link to the full warning on VicEmergency
function warningLink(p) {
  const m = /More details at (https?:\/\/\S+)/.exec(p.text || "");
  if (m) return m[1].replace(/^http:/, "https:");
  if (p.sourceFeed === "cop-cap" && p.sourceId) return `https://emergency.vic.gov.au/respond/#!/warning/${p.sourceId}/moreinfo`;
  if (p.url && /^https?:/.test(p.url)) return p.url;
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
    if (data.error) return { error: "Feed unavailable", incidents: [], feedSource: "none", feedUpdated: null, conditions: null };

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
    const props = (format === "geojson" && feedData.properties) || {};
    return {
      error: null,
      incidents: rawIncidents,
      feedSource: format,
      feedUpdated: props.lastUpdated || null,
      conditions: props.conditions || null,
    };

  } catch (e) {
    return { error: `Parse error: ${e.message}`, incidents: [], feedSource: "none", feedUpdated: null, conditions: null };
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
    const isWarning = p.feedType && p.feedType !== "incident" && p.feedType !== "burn-area";

    // Warning areas: keep the outline, check whether home is inside, measure to the nearest edge
    let dist = haversine(cfg.HOME_LAT, cfg.HOME_LON, coords.lat, coords.lon);
    let homeInside = false;
    let polygons = [];
    if (isWarning) {
      const rings = extractRings(f.geometry);
      homeInside = rings.some((r) => pointInRing(cfg.HOME_LAT, cfg.HOME_LON, r));
      for (const r of rings) {
        const step = Math.max(1, Math.ceil(r.length / 400));
        for (let i = 0; i < r.length; i += step) {
          dist = Math.min(dist, haversine(cfg.HOME_LAT, cfg.HOME_LON, r[i][1], r[i][0]));
        }
      }
      if (homeInside) dist = 0;
      polygons = rings.map((r) => thinRing(r, 150));
    }
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
      issued: p.updated || p.created || "",
      location: p.location || "",
      sourceOrg: p.sourceOrg || "",
      resources: parseInt(p.resources) || 0,
      group,
      warningLevel,
      distance: Math.round(dist * 10) / 10,
      bearing,
      lat: coords.lat,
      lon: coords.lon,
      homeInside,
      polygons,
      action: isWarning ? (p.action || "") : "",
      advice: isWarning ? htmlToText(p.webBody || p.text).slice(0, 300) : "",
      link: isWarning ? warningLink(p) : (p.url && /^https?:/.test(p.url) ? p.url : null),
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
// Source: Emergency Management Victoria, "Emergency radio broadcasters (Regional)" (checked October 2026);
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
// ▸ FIRE DANGER — rating and Total Fire Ban for the home fire weather district
// Ratings come with the VicEmergency feed (properties.conditions). District is
// picked from the nearest town; towns follow CFA's council-to-district list
// ("Find your fire weather district"). Override with FIRE_DISTRICT.
// ─────────────────────────────────────────────────────────────

const FIRE_DISTRICTS = ["Mallee", "Wimmera", "South West", "Northern Country", "North Central",
  "Central", "North East", "East Gippsland", "West and South Gippsland"];

// [lat, lon, district] — main towns of each council
const FIRE_DISTRICT_POINTS = [
  [-34.19, 142.16, "Mallee"], [-35.07, 142.32, "Mallee"], [-34.58, 142.77, "Mallee"], [-35.34, 143.55, "Mallee"],
  [-35.73, 143.92, "Mallee"], [-35.81, 144.22, "Mallee"], [-36.26, 143.35, "Mallee"], [-36.37, 142.98, "Mallee"],
  [-36.08, 143.23, "Mallee"], [-35.50, 142.85, "Mallee"], [-35.73, 142.37, "Mallee"], [-35.98, 142.92, "Mallee"],
  [-36.71, 142.20, "Wimmera"], [-36.33, 141.65, "Wimmera"], [-36.45, 142.03, "Wimmera"], [-36.25, 142.39, "Wimmera"],
  [-37.04, 141.29, "Wimmera"], [-36.38, 141.24, "Wimmera"], [-37.06, 142.78, "Wimmera"], [-36.62, 143.26, "Wimmera"],
  [-37.14, 142.52, "Wimmera"],
  [-37.28, 142.93, "South West"], [-37.43, 143.38, "South West"], [-37.09, 143.47, "South West"], [-38.34, 143.58, "South West"],
  [-38.76, 143.67, "South West"], [-38.23, 143.15, "South West"], [-38.33, 143.07, "South West"], [-38.34, 141.60, "South West"],
  [-37.59, 141.40, "South West"], [-38.13, 141.63, "South West"], [-38.38, 142.24, "South West"], [-38.08, 142.80, "South West"],
  [-37.74, 142.02, "South West"], [-37.60, 141.69, "South West"], [-38.38, 142.48, "South West"],
  [-36.13, 144.75, "Northern Country"], [-36.36, 144.70, "Northern Country"], [-36.31, 145.05, "Northern Country"],
  [-36.76, 144.28, "Northern Country"], [-36.92, 144.71, "Northern Country"], [-36.38, 145.40, "Northern Country"],
  [-36.42, 143.61, "Northern Country"], [-36.57, 143.87, "Northern Country"], [-36.12, 143.72, "Northern Country"],
  [-35.92, 145.65, "Northern Country"], [-36.02, 146.00, "Northern Country"], [-36.09, 145.44, "Northern Country"],
  [-36.75, 145.57, "Northern Country"], [-36.79, 145.15, "Northern Country"],
  [-36.05, 144.11, "Northern Country"], [-36.21, 144.23, "Northern Country"], [-36.41, 143.97, "Northern Country"],
  [-37.05, 143.74, "North Central"], [-36.86, 143.73, "North Central"], [-37.03, 145.14, "North Central"],
  [-37.30, 144.95, "North Central"], [-37.42, 144.98, "North Central"], [-37.20, 145.05, "North Central"],
  [-37.06, 144.22, "North Central"], [-36.99, 144.26, "North Central"], [-37.19, 145.71, "North Central"],
  [-37.21, 145.43, "North Central"], [-37.53, 145.33, "North Central"], [-37.51, 145.75, "North Central"],
  [-37.23, 145.91, "North Central"], [-37.49, 145.88, "North Central"],
  [-37.81, 144.96, "Central"], [-38.15, 144.36, "Central"], [-37.56, 143.85, "Central"], [-37.35, 144.14, "Central"],
  [-37.42, 143.89, "Central"], [-37.25, 144.45, "Central"], [-37.49, 144.59, "Central"], [-37.36, 144.53, "Central"],
  [-37.68, 144.44, "Central"], [-37.60, 144.23, "Central"], [-38.33, 144.33, "Central"], [-38.54, 143.98, "Central"],
  [-37.97, 144.17, "Central"], [-37.64, 143.68, "Central"], [-37.68, 144.58, "Central"], [-37.58, 144.73, "Central"],
  [-37.60, 144.94, "Central"], [-37.51, 145.12, "Central"], [-37.71, 145.15, "Central"], [-37.64, 145.19, "Central"],
  [-37.65, 145.52, "Central"], [-37.75, 145.69, "Central"], [-37.76, 145.35, "Central"], [-38.07, 145.49, "Central"],
  [-38.20, 145.49, "Central"], [-38.10, 145.28, "Central"], [-38.14, 145.12, "Central"], [-38.36, 144.91, "Central"],
  [-38.61, 145.59, "Central"], [-38.48, 145.23, "Central"], [-37.90, 144.66, "Central"], [-37.99, 145.21, "Central"],
  [-38.27, 144.66, "Central"],
  [-36.12, 146.89, "North East"], [-36.36, 146.32, "North East"], [-36.36, 146.69, "North East"], [-36.05, 146.46, "North East"],
  [-36.15, 146.61, "North East"], [-36.73, 146.96, "North East"], [-36.56, 146.72, "North East"], [-36.74, 147.17, "North East"],
  [-36.87, 147.28, "North East"], [-36.98, 147.13, "North East"], [-36.55, 145.98, "North East"], [-37.05, 146.08, "North East"],
  [-37.15, 146.44, "North East"], [-37.03, 145.86, "North East"], [-36.20, 147.90, "North East"], [-36.22, 147.18, "North East"],
  [-36.89, 147.06, "North East"],
  [-37.83, 147.61, "East Gippsland"], [-37.88, 147.99, "East Gippsland"], [-37.71, 148.46, "East Gippsland"],
  [-37.10, 147.60, "East Gippsland"], [-37.56, 149.75, "East Gippsland"], [-37.57, 149.15, "East Gippsland"],
  [-37.92, 147.72, "East Gippsland"], [-37.26, 147.72, "East Gippsland"],
  [-38.16, 145.93, "West and South Gippsland"], [-38.14, 145.86, "West and South Gippsland"], [-37.89, 146.00, "West and South Gippsland"],
  [-37.84, 146.27, "West and South Gippsland"], [-38.20, 146.54, "West and South Gippsland"], [-38.24, 146.40, "West and South Gippsland"],
  [-38.18, 146.26, "West and South Gippsland"], [-38.31, 146.42, "West and South Gippsland"], [-38.48, 145.95, "West and South Gippsland"],
  [-38.43, 145.82, "West and South Gippsland"], [-38.65, 146.20, "West and South Gippsland"], [-38.40, 146.16, "West and South Gippsland"],
  [-38.11, 147.07, "West and South Gippsland"], [-37.97, 146.98, "West and South Gippsland"], [-38.56, 146.68, "West and South Gippsland"],
  [-37.98, 146.79, "West and South Gippsland"], [-38.15, 146.79, "West and South Gippsland"],
];

// Australian Fire Danger Rating System colours
const FDR_STYLE = {
  "MODERATE":     { label: "Moderate",     colour: "#64BF30", text: "#FFFFFF" },
  "HIGH":         { label: "High",         colour: "#FFE000", text: "#1E1E20" },
  "EXTREME":      { label: "Extreme",      colour: "#F78100", text: "#FFFFFF" },
  "CATASTROPHIC": { label: "Catastrophic", colour: "#AD0909", text: "#FFFFFF" },
};

// Mini fire danger gauge: four segments in rating colours, pointer on the current rating
const FDR_ORDER = ["MODERATE", "HIGH", "EXTREME", "CATASTROPHIC"];

function FdrDial({ rating, width = 26 }) {
  const cx = 13, cy = 13, r = 9;
  const pt = (deg, rad) => [cx + rad * Math.cos(deg * Math.PI / 180), cy - rad * Math.sin(deg * Math.PI / 180)];
  const level = FDR_ORDER.indexOf(rating);
  const segs = FDR_ORDER.map((key, i) => {
    const a1 = 180 - i * 45 - (i === 0 ? 0 : 1.5), a2 = 180 - (i + 1) * 45 + (i === 3 ? 0 : 1.5);
    const [x1, y1] = pt(a1, r), [x2, y2] = pt(a2, r);
    return <path key={key} d={`M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`}
                 stroke={FDR_STYLE[key].colour} strokeWidth="4.5" fill="none" opacity={level < 0 ? 0.35 : 1} />;
  });
  const [nx, ny] = pt(180 - level * 45 - 22.5, r - 1);
  return (
    <svg className="ve-dial" width={width} height={width * 15 / 26} viewBox="0 0 26 15" aria-hidden="true">
      {segs}
      {level >= 0 && <line x1={cx} y1={cy} x2={nx.toFixed(2)} y2={ny.toFixed(2)} stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" />}
      <circle cx={cx} cy={cy} r="1.8" fill={level >= 0 ? "#FFFFFF" : "#8E8E93"} />
    </svg>
  );
}

function pickFireDistrict(cfg) {
  if (cfg.FIRE_DISTRICT && cfg.FIRE_DISTRICT !== "auto" && FIRE_DISTRICTS.includes(cfg.FIRE_DISTRICT)) return cfg.FIRE_DISTRICT;
  let best = null;
  for (const [lat, lon, district] of FIRE_DISTRICT_POINTS) {
    const d = haversine(cfg.HOME_LAT, cfg.HOME_LON, lat, lon);
    if (!best || d < best.d) best = { d, district };
  }
  return best && best.d <= 150 ? best.district : null;
}

function melbDate(d) {
  return d.toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" }); // YYYY-MM-DD
}

// { district, today: {rating, tfb, date}, tomorrow: {...} } or null when unavailable
function fireInfo(conditions, cfg) {
  const district = pickFireDistrict(cfg);
  if (!conditions || !district) return district ? { district, unavailable: true } : null;
  const today = melbDate(new Date());
  const tomorrow = melbDate(new Date(Date.now() + 86400000));
  const day = (src, date) => src && src.fdr ? {
    date,
    rating: String((src.fdr || {})[district] || "").toUpperCase(),
    tfb: /^YES/i.test(String((src.tfb || {})[district] || "")),
  } : null;
  const forecasts = Array.isArray(conditions.forecasts) ? conditions.forecasts : [];
  const byDate = (date) => forecasts.find((f) => f.date && melbDate(new Date(f.date)) === date);
  // Up to four days: today plus the forecast days that follow
  const days = [day(byDate(today) || conditions, today)];
  for (const f of forecasts) {
    const date = f.date ? melbDate(new Date(f.date)) : "";
    if (date > today && days.length < 4) days.push(day(f, date));
  }
  const heat = String((conditions.heat || {})[district] || "");
  const asthma = String((conditions.asthma || {})[district] || "");
  return {
    district,
    today: days[0],
    tomorrow: day(byDate(tomorrow), tomorrow),
    days: days.filter(Boolean),
    // Shown only when they matter (keep the widget quiet otherwise)
    heat: heat && !/not declared|none/i.test(heat) ? heat : "",
    asthma: /moderate|high/i.test(asthma) ? asthma : "",
  };
}

const CFA_FDR_URL = "https://www.cfa.vic.gov.au/warnings-and-restrictions/fire-bans-ratings-and-restrictions/total-fire-bans-fire-danger-ratings";
// CFA's page for one fire weather district (shows its 4-day outlook)
function cfaFdrUrl(district) {
  const slug = String(district || "").toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
  return slug ? `${CFA_FDR_URL}/${slug}-fire-district` : CFA_FDR_URL;
}

function dayLabel(date, i) {
  if (i === 0) return "Today";
  const d = new Date(date + "T12:00:00");
  return d.toLocaleDateString("en-AU", { weekday: "short" });
}

// ─────────────────────────────────────────────────────────────
// ▸ CFA RADIO — Broadcastify feed of the CFA district dispatch channel.
// Each CFA incident gets a link to the feed for its district (nearest listed
// town). Broadcastify's own player opens in the browser; a direct audio link
// needs a Broadcastify premium account. Towns per district are those listed on
// each feed's Broadcastify page (checked October 2026).
// ─────────────────────────────────────────────────────────────

const CFA_FEEDS = {
  2: 19012, 4: 19008, 5: 19009, 6: 19010, 7: 19011, 8: 18994, 9: 41819, 10: 19001, 11: 19004,
  12: 18876, 13: 18999, 14: 18998, 15: 18997, 16: 18996, 17: 18995, 18: 19014, 20: 19013,
  22: 19007, 23: 19006, 24: 19005, 27: 19003,
};

// [lat, lon, CFA district]
const CFA_TOWNS = [
  // District 2
  [-36.769, 143.557, 2], [-36.759, 144.283, 2], [-37.204, 144.675, 2], [-37.066, 144.220, 2], [-36.870, 144.796, 2], [-36.859, 143.734, 2],
  [-36.493, 144.609, 2], [-37.487, 144.590, 2], [-36.615, 144.505, 2], [-36.916, 144.703, 2], [-36.496, 144.391, 2], [-37.247, 144.455, 2],
  [-37.276, 144.734, 2], [-37.421, 144.564, 2], [-36.996, 144.069, 2], [-37.047, 143.738, 2], [-36.807, 144.752, 2], [-36.535, 144.205, 2],
  [-37.021, 144.532, 2], [-37.352, 144.737, 2], [-37.330, 144.640, 2], [-37.176, 143.695, 2],
  // District 4
  [-37.395, 141.406, 4], [-38.330, 141.434, 4], [-37.585, 141.404, 4], [-37.941, 141.700, 4], [-37.895, 141.268, 4], [-37.813, 141.540, 4],
  [-38.132, 141.626, 4], [-38.133, 141.802, 4], [-37.947, 141.564, 4], [-37.487, 141.090, 4], [-37.733, 141.531, 4], [-38.078, 141.142, 4],
  [-38.346, 141.604, 4], [-37.648, 141.464, 4], [-37.739, 141.118, 4], [-37.744, 141.703, 4], [-38.208, 141.785, 4], [-37.926, 141.813, 4],
  [-37.488, 141.491, 4],
  // District 5
  [-37.248, 141.841, 5], [-37.847, 141.810, 5], [-37.840, 142.660, 5], [-38.265, 141.969, 5], [-37.600, 141.690, 5], [-37.899, 142.984, 5],
  [-37.649, 142.344, 5], [-37.636, 142.547, 5], [-37.743, 142.024, 5], [-37.142, 141.623, 5], [-38.087, 142.279, 5], [-38.045, 142.043, 5],
  [-37.400, 142.401, 5], [-38.058, 142.793, 5], [-37.876, 142.337, 5], [-38.606, 142.877, 5], [-38.386, 142.237, 5], [-38.383, 142.481, 5],
  [-38.084, 142.992, 5],
  // District 6
  [-38.755, 143.669, 6], [-38.195, 143.640, 6], [-38.637, 143.574, 6], [-38.338, 143.784, 6], [-38.229, 143.137, 6], [-38.857, 143.511, 6],
  [-38.328, 143.078, 6], [-38.340, 143.586, 6], [-38.030, 143.633, 6], [-37.978, 143.052, 6], [-38.519, 143.716, 6], [-38.526, 143.540, 6],
  [-37.954, 143.362, 6], [-38.620, 142.995, 6], [-38.693, 143.156, 6], [-38.496, 143.208, 6], [-37.689, 143.332, 6], [-38.247, 142.877, 6],
  [-38.485, 142.981, 6], [-38.633, 143.890, 6],
  // District 7
  [-38.462, 144.107, 7], [-37.911, 144.254, 7], [-38.405, 144.189, 7], [-38.275, 144.488, 7], [-38.397, 143.885, 7], [-38.173, 144.571, 7],
  [-38.149, 144.360, 7], [-38.170, 144.159, 7], [-38.024, 144.409, 7], [-38.189, 144.464, 7], [-38.541, 143.975, 7], [-38.263, 144.121, 7],
  [-38.267, 144.525, 7], [-38.116, 144.653, 7], [-38.267, 144.661, 7], [-38.327, 144.313, 7], [-38.242, 143.986, 7],
  // District 8
  [-38.040, 145.345, 8], [-38.097, 145.721, 8], [-38.450, 145.239, 8], [-38.100, 145.281, 8], [-37.990, 145.210, 8], [-38.146, 145.126, 8],
  [-38.350, 145.389, 8], [-38.306, 145.186, 8], [-38.266, 145.563, 8], [-38.220, 145.041, 8], [-38.081, 145.486, 8], [-38.323, 144.700, 8],
  [-38.371, 144.910, 8], [-38.214, 145.382, 8], [-38.604, 145.591, 8],
  // District 9
  [-38.297, 146.018, 9], [-38.136, 145.856, 9], [-38.525, 146.120, 9], [-37.976, 146.380, 9], [-38.694, 146.084, 9], [-38.651, 146.202, 9],
  [-38.633, 145.728, 9], [-38.559, 145.953, 9], [-38.432, 145.824, 9], [-38.476, 145.946, 9], [-38.370, 145.707, 9], [-38.126, 145.765, 9],
  [-38.528, 146.206, 9], [-38.401, 146.159, 9], [-38.010, 145.994, 9], [-38.507, 146.020, 9], [-38.122, 146.009, 9], [-37.835, 145.944, 9],
  [-38.340, 145.763, 9], [-38.773, 145.917, 9], [-38.304, 146.181, 9], [-38.320, 145.972, 9], [-38.159, 145.934, 9], [-38.666, 146.436, 9],
  // District 10
  [-37.322, 147.333, 10], [-37.914, 146.756, 10], [-37.982, 146.785, 10], [-37.603, 146.570, 10], [-38.171, 147.086, 10], [-37.965, 146.976, 10],
  [-38.015, 147.405, 10], [-38.691, 146.671, 10], [-38.185, 146.827, 10], [-38.109, 147.066, 10], [-38.332, 147.161, 10], [-38.278, 147.039, 10],
  [-37.946, 147.115, 10], [-38.537, 146.899, 10], [-38.562, 146.676, 10],
  // District 11
  [-37.825, 147.630, 11], [-37.640, 148.887, 11], [-36.890, 147.802, 11], [-37.188, 148.891, 11], [-37.975, 147.439, 11], [-37.149, 148.648, 11],
  [-37.499, 148.172, 11], [-37.588, 149.162, 11], [-37.192, 148.226, 11], [-37.751, 147.317, 11], [-37.878, 148.002, 11], [-37.560, 149.757, 11],
  [-37.764, 148.732, 11], [-37.866, 147.809, 11], [-37.100, 147.592, 11], [-37.704, 148.455, 11], [-37.911, 147.720, 11], [-37.264, 147.724, 11],
  // District 12
  [-37.192, 145.711, 12], [-37.216, 145.053, 12], [-37.233, 145.910, 12], [-37.330, 145.303, 12], [-37.292, 144.951, 12], [-37.533, 145.341, 12],
  [-37.504, 145.881, 12], [-37.510, 145.749, 12], [-37.542, 145.639, 12], [-37.001, 145.036, 12], [-37.024, 145.136, 12], [-37.350, 145.726, 12],
  [-37.043, 144.799, 12], [-37.414, 144.977, 12], [-37.101, 145.617, 12], [-37.213, 145.422, 12],
  // District 13
  [-37.842, 145.268, 13], [-37.600, 145.416, 13], [-37.882, 145.295, 13], [-37.654, 145.516, 13], [-37.842, 145.593, 13], [-37.757, 145.346, 13],
  [-37.887, 145.475, 13], [-37.908, 145.357, 13], [-37.810, 145.342, 13], [-37.785, 145.313, 13], [-37.836, 145.350, 13], [-37.963, 145.362, 13],
  [-37.856, 145.365, 13], [-37.863, 145.751, 13], [-37.670, 145.902, 13], [-37.924, 145.245, 13], [-37.903, 145.218, 13], [-37.754, 145.689, 13],
  [-37.738, 145.224, 13], [-37.657, 145.374, 13], [-37.782, 145.615, 13], [-37.810, 145.510, 13],
  // District 14
  [-37.584, 145.207, 14], [-37.734, 144.737, 14], [-37.653, 145.321, 14], [-37.602, 144.943, 14], [-37.714, 145.148, 14], [-37.652, 145.032, 14],
  [-37.791, 144.556, 14], [-37.883, 144.701, 14], [-37.639, 145.192, 14], [-37.692, 145.216, 14], [-37.887, 144.472, 7], [-37.684, 144.583, 14],
  [-37.667, 145.112, 14], [-37.906, 144.753, 14], [-37.580, 144.730, 14], [-37.607, 144.594, 14], [-37.900, 144.661, 14], [-37.512, 145.118, 14],
  // District 15
  [-37.675, 144.437, 15], [-37.604, 144.214, 15], [-37.562, 143.861, 15], [-38.044, 144.174, 15], [-37.650, 143.884, 15], [-37.470, 143.655, 15],
  [-37.206, 143.960, 15], [-37.288, 143.780, 15], [-37.425, 143.894, 15], [-37.341, 144.147, 15], [-37.316, 144.147, 15], [-37.694, 143.562, 15],
  [-37.844, 144.075, 15], [-37.902, 143.720, 15], [-38.012, 143.973, 15], [-37.390, 144.326, 15],
  // District 16
  [-37.283, 142.932, 16], [-37.089, 143.474, 16], [-37.429, 143.383, 16], [-36.921, 142.645, 16], [-37.699, 142.847, 16], [-37.276, 143.516, 16],
  [-37.422, 142.846, 16], [-37.302, 142.766, 16], [-36.900, 143.114, 16], [-36.450, 142.908, 16], [-36.615, 143.255, 16], [-37.059, 142.775, 16],
  [-37.544, 142.740, 16],
  // District 17
  [-36.979, 141.088, 17], [-37.063, 142.197, 17], [-36.904, 142.495, 17], [-37.342, 141.188, 17], [-36.455, 142.027, 17], [-36.715, 142.202, 17],
  [-36.119, 141.995, 17], [-36.380, 141.242, 17], [-36.461, 142.587, 17], [-36.741, 141.942, 17], [-36.693, 141.019, 17], [-36.333, 141.649, 17],
  [-35.898, 141.996, 17], [-36.642, 142.685, 17], [-37.120, 142.016, 17], [-36.029, 141.108, 17], [-36.251, 142.395, 17],
  // District 18
  [-35.983, 142.916, 18], [-36.269, 143.352, 18], [-36.370, 142.983, 18], [-35.730, 142.364, 18], [-34.195, 142.150, 18], [-35.263, 141.183, 18],
  [-35.069, 142.316, 18], [-34.584, 142.774, 18], [-35.506, 142.851, 18], [-35.339, 143.559, 18], [-36.079, 143.228, 18],
  // District 20
  [-36.118, 143.722, 20], [-35.808, 144.220, 20], [-36.128, 144.752, 20], [-35.957, 144.367, 20], [-36.573, 143.869, 20], [-35.734, 143.920, 20],
  [-36.313, 145.048, 20], [-36.215, 144.236, 20], [-36.054, 144.116, 20], [-35.850, 143.521, 20], [-36.586, 145.016, 20], [-36.445, 144.983, 20],
  [-36.775, 143.831, 20], [-36.720, 144.680, 20], [-36.419, 143.614, 20], [-36.209, 145.069, 20],
  // District 22
  [-36.016, 144.961, 22], [-36.033, 146.166, 22], [-35.920, 145.648, 22], [-36.333, 145.710, 22], [-36.773, 145.583, 22], [-36.626, 145.181, 22],
  [-36.792, 145.214, 22], [-36.058, 145.207, 22], [-36.093, 145.442, 22], [-35.962, 145.126, 22], [-36.383, 145.399, 22], [-36.877, 145.766, 22],
  [-35.905, 145.449, 22], [-36.243, 145.214, 22], [-36.637, 145.718, 22], [-36.014, 146.006, 22],
  // District 23
  [-36.552, 145.983, 23], [-37.011, 145.865, 23], [-36.321, 145.903, 23], [-36.312, 146.531, 23], [-36.462, 146.226, 23], [-37.303, 146.138, 23],
  [-37.052, 146.088, 23], [-36.981, 145.708, 23], [-37.269, 146.401, 23], [-36.210, 146.478, 23], [-36.356, 146.323, 23], [-36.751, 146.418, 23],
  [-37.560, 146.342, 23],
  // District 24
  [-36.359, 146.687, 24], [-36.729, 146.961, 24], [-36.151, 146.609, 24], [-36.186, 147.897, 24], [-36.612, 147.614, 24], [-36.475, 147.002, 24],
  [-36.879, 147.244, 24], [-36.270, 147.013, 24], [-36.625, 147.328, 24], [-36.749, 147.229, 24], [-36.975, 147.128, 24], [-36.561, 146.724, 24],
  [-36.054, 146.460, 24], [-36.217, 147.178, 24], [-35.964, 147.736, 24], [-36.121, 146.888, 24], [-36.330, 146.852, 24],
  // District 27
  [-38.381, 146.272, 27], [-38.313, 146.420, 27], [-38.127, 146.642, 27], [-38.271, 146.479, 27], [-38.177, 146.262, 27], [-38.236, 146.398, 27],
  [-38.035, 146.572, 27], [-38.195, 146.538, 27], [-38.129, 146.379, 27], [-38.335, 146.301, 27],
];

function cfaDistrictAt(lat, lon) {
  let best = null;
  for (const [tlat, tlon, district] of CFA_TOWNS) {
    const d = haversine(lat, lon, tlat, tlon);
    if (!best || d < best.d) best = { d, district };
  }
  return best && best.d <= 60 ? best.district : null;
}

// Responsible agency, shown only on hover
const AGENCIES = [
  [/CFA/i, "CFA (Country Fire Authority)"],
  [/DEECA|DELWP|FFMV/i, "Forest Fire Management Victoria (DEECA)"],
  [/SES/i, "VICSES (State Emergency Service)"],
  [/FRV|MFB/i, "FRV (Fire Rescue Victoria)"],
  [/ESTA/i, "Triple Zero Victoria"],
  [/EMV/i, "Emergency Management Victoria"],
  [/BOM/i, "Bureau of Meteorology"],
  [/EPA/i, "EPA Victoria"],
  [/POL/i, "Victoria Police"],
];
function agencyName(org) {
  if (!org) return "";
  const hit = AGENCIES.find(([re]) => re.test(org));
  return hit ? hit[1] : org.replace(/^[A-Z]+\//, "");
}

function cfaRadio(inc) {
  if (!/CFA/i.test(inc.sourceOrg || "")) return null;
  const district = cfaDistrictAt(inc.lat, inc.lon);
  if (!district || !CFA_FEEDS[district]) return null;
  return { district, url: `https://www.broadcastify.com/listen/feed/${CFA_FEEDS[district]}` };
}

// ─────────────────────────────────────────────────────────────
// ▸ ALERTS — macOS notification for new or escalated warnings near home,
// warnings covering home, Total Fire Bans and Extreme/Catastrophic ratings.
// What has been alerted is kept in ~/.vicemergency-alerted.json.
// ─────────────────────────────────────────────────────────────

const LEVEL_LABEL = { advice: "Advice", watch_and_act: "Watch and Act", emergency_warning: "Emergency Warning" };

function shq(str) { return "'" + String(str).replace(/'/g, "'\\''") + "'"; }

function collectAlerts(incidents, fire, cfg, previous) {
  const state = {};
  const alerts = [];
  const minPriority = WARNING_PRIORITY[cfg.ALERT_LEVEL] || WARNING_PRIORITY.watch_and_act;
  const seen = (key, value) => {
    const before = (previous && previous[key]) || _alertedSession[key] || 0;
    state[key] = Math.max(value, before);
    return value > before;
  };

  for (const inc of incidents) {
    if (!inc.warningLevel) continue;
    const pr = WARNING_PRIORITY[inc.warningLevel] || 0;
    if (!inc.homeInside && pr < minPriority) continue;
    const key = `w:${inc.id}`;
    const value = pr + (inc.homeInside ? 10 : 0);
    if (seen(key, value)) {
      const where = inc.location || inc.title || "";
      alerts.push({
        title: `VicEmergency \u2014 ${LEVEL_LABEL[inc.warningLevel] || "Warning"}`,
        message: inc.homeInside
          ? `Your location is inside this warning area: ${inc.eventType || inc.category2 || inc.category1} \u2014 ${where}. ${inc.action || ""}`
          : `${inc.eventType || inc.category2 || inc.category1} \u2014 ${where}, ${inc.distance} km ${inc.bearing}. ${inc.action || ""}`,
      });
    }
  }

  if (fire && !fire.unavailable) {
    for (const [when, day] of [["today", fire.today], ["tomorrow", fire.tomorrow]]) {
      if (!day) continue;
      if (day.tfb && seen(`tfb:${day.date}`, 1)) {
        alerts.push({ title: "VicEmergency \u2014 Total Fire Ban", message: `Total Fire Ban ${when} in the ${fire.district} district.` });
      }
      const rank = { EXTREME: 1, CATASTROPHIC: 2 }[day.rating] || 0;
      if (rank && seen(`fdr:${day.date}`, rank)) {
        alerts.push({ title: `VicEmergency \u2014 ${FDR_STYLE[day.rating].label} fire danger`,
          message: `Fire danger is ${FDR_STYLE[day.rating].label.toUpperCase()} ${when} in the ${fire.district} district.` });
      }
    }
  }
  return { alerts, state };
}

function sendAlerts(alerts, state, cfg) {
  Object.assign(_alertedSession, state);
  const cmds = alerts.slice(0, 4).map((a) =>
    `osascript -e 'on run argv' -e 'display notification (item 2 of argv) with title (item 1 of argv)${cfg.ALERT_SOUND ? ' sound name "Sosumi"' : ""}' -e 'end run' ${shq(a.title)} ${shq(a.message)}`);
  if (alerts.length > 4) {
    cmds.push(`osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "VicEmergency"' -e 'end run' ${shq(`${alerts.length - 4} more warnings \u2014 see the widget`)}`);
  }
  cmds.push(`printf '%s' ${shq(JSON.stringify(state))} > ${ALERT_STATE_PATH}`);
  run(cmds.join("; "));
}

// ─────────────────────────────────────────────────────────────
// ▸ MAP — self-contained Leaflet in an iframe
// ─────────────────────────────────────────────────────────────

const GROUP_COLOURS = {
  fire: "#E53935", flood: "#42A5F5", storm_weather: "#AB47BC",
  transport: "#FB8C00", hazmat_health: "#66BB6A", outages_closures: "#78909C",
  quake: "#A1887F", other: "#BDBDBD",
};

const FEEDTYPE_COLOURS = {
  warning: "#FFC107", "watch-and-act": "#FF6D00", "emergency-warning": "#D50000",
};

function buildMapHtml(incidents, cfg) {
  const markers = incidents.map((inc) => {
    const colour = FEEDTYPE_COLOURS[inc.feedType] || GROUP_COLOURS[inc.group] || GROUP_COLOURS.other;
    const label = inc.eventType || inc.category1 || inc.title || "Incident";
    const detail = inc.location || "";
    const dist = inc.distance;
    return { lat: inc.lat, lon: inc.lon, colour, label, detail, dist, feedType: inc.feedType, resources: inc.resources, group: inc.group,
             polygons: inc.polygons || [], action: inc.action || "", inside: !!inc.homeInside,
             level: inc.warningLevel || "", state: inc.warningLevel ? "" : statusClass(inc.status),
             when: inc.issued ? `${inc.warningLevel ? "Issued" : "Updated"} ${whenText(inc.issued)}` : "",
             agency: agencyName(inc.sourceOrg),
             radio: inc.cfaRadio ? { label: `CFA District ${inc.cfaRadio.district} radio`, url: inc.cfaRadio.url } : null };
  });

  const dataJson = JSON.stringify({ home: { lat: cfg.HOME_LAT, lon: cfg.HOME_LON }, markers, zoom: cfg.MAP_ZOOM, filter: _groupFilter })
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

  const isLight = cfg.MAP_THEME === "light";
  // Esri Canvas basemaps (no API key needed): plain base plus a labels layer on top.
  // (CARTO basemaps started requiring an API key in 2026.)
  const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
  const tileUrl = esri + (isLight ? 'World_Light_Gray_Base' : 'World_Dark_Gray_Base') + '/MapServer/tile/{z}/{y}/{x}';
  const labelUrl = esri + (isLight ? 'World_Light_Gray_Reference' : 'World_Dark_Gray_Reference') + '/MapServer/tile/{z}/{y}/{x}';
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
  .ve-popup-radio { margin-top: 4px; font-size: 11px; }
  .ve-sym { background: none; border: none; }
  .ve-sym svg { display: block; filter: drop-shadow(0 1px 1.5px rgba(0,0,0,0.35)); }
  .ve-popup-radio a { color: #4A90D9; text-decoration: none; }
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
    attribution: 'Tiles \\u00a9 Esri, HERE, Garmin, \\u00a9 <a href="https://www.openstreetmap.org/copyright">OSM</a>' + (${cfg.SHOW_EARTHQUAKES ? 'true' : 'false'} ? ', quakes \u00a9 Geoscience Australia' : ''),
    maxZoom: 16
  }).addTo(map);
  L.tileLayer('${labelUrl}', { maxZoom: 16, pane: 'overlayPane' }).addTo(map);

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

  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function(c) { return '&#' + c.charCodeAt(0) + ';'; }); }

  // Warning areas — outlines under the markers
  var polyRefs = [];
  d.markers.forEach(function(m, idx) {
    polyRefs[idx] = [];
    (m.polygons || []).forEach(function(ring) {
      if (ring.length < 3) return;
      polyRefs[idx].push(L.polygon(ring, { color: m.colour, weight: 1.5, fillColor: m.colour, fillOpacity: m.inside ? 0.22 : 0.12, interactive: false }).addTo(map));
    });
  });

  // Map symbols in the style of the national warning display:
  // warnings are triangles that grow with the warning level; incidents are
  // circles in their category colour — solid while crews are responding,
  // lighter once under control, hollow and faded once safe.
  var LEVEL = { advice: { c: '#FFC107', s: 20 }, watch_and_act: { c: '#FF6D00', s: 24 }, emergency_warning: { c: '#D50000', s: 28 } };
  function symbol(m) {
    var svg, size;
    if (m.level) {
      var L1 = LEVEL[m.level] || LEVEL.advice; size = L1.s;
      svg = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24">' +
        '<path d="M12 2.5 L22.5 21 H1.5 Z" fill="' + L1.c + '" stroke="' + (m.inside ? '#FFFFFF' : 'rgba(0,0,0,0.45)') + '" stroke-width="' + (m.inside ? 2.2 : 1.2) + '" stroke-linejoin="round"/>' +
        '<rect x="11" y="8.5" width="2" height="6.5" rx="1" fill="' + (m.level === 'advice' ? '#1E1E20' : '#FFFFFF') + '"/>' +
        '<circle cx="12" cy="17.6" r="1.25" fill="' + (m.level === 'advice' ? '#1E1E20' : '#FFFFFF') + '"/></svg>';
    } else {
      size = 16;
      var st = m.state;
      svg = '<svg width="16" height="16" viewBox="0 0 16 16">' +
        (st === 'finished'
          ? '<circle cx="8" cy="8" r="5.5" fill="none" stroke="' + m.colour + '" stroke-width="1.6" stroke-dasharray="2.5 2" opacity="0.7"/>'
          : '<circle cx="8" cy="8" r="6" fill="' + m.colour + '" fill-opacity="' + (st === 'active' ? 0.95 : 0.4) + '" stroke="' + (st === 'active' ? '#FFFFFF' : m.colour) + '" stroke-width="' + (st === 'active' ? 1.8 : 1.6) + '"/>') +
        '</svg>';
    }
    return L.divIcon({ className: 've-sym', html: svg, iconSize: [size, size], iconAnchor: [size / 2, m.level ? size * 0.6 : size / 2], popupAnchor: [0, -size / 2] });
  }

  // Incident markers — store references for panTo
  var markerRefs = [];
  d.markers.forEach(function(m, idx) {
    var cm = L.marker([m.lat, m.lon], { icon: symbol(m), title: m.agency || "", riseOnHover: true, zIndexOffset: m.level ? 1000 : 0 }).addTo(map).bindPopup(
      '<div class="ve-popup">' +
        '<div class="ve-popup-title" style="color:' + m.colour + '">' + esc(m.label) + '</div>' +
        (m.detail ? '<div class="ve-popup-detail">' + esc(m.detail) + '</div>' : '') +
        (m.action ? '<div class="ve-popup-detail"><b>' + esc(m.action) + '</b></div>' : '') +
        (m.inside ? '<div class="ve-popup-detail" style="color:#D50000"><b>Your location is inside this area</b></div>' : '') +
        (m.radio ? '<div class="ve-popup-radio"><a href="#" data-url="' + esc(m.radio.url) + '">\uD83C\uDFA7 ' + esc(m.radio.label) + '</a></div>' : '') +
        (m.when ? '<div class="ve-popup-dist">' + esc(m.when) + '</div>' : '') +
        '<div class="ve-popup-dist">' + m.dist + ' km away' + (m.resources > 0 ? ' \\u00b7 ' + m.resources + ' appliance' + (m.resources !== 1 ? 's' : '') : '') + '</div>' +
      '</div>'
    );
    markerRefs.push(cm);
  });

  // Category filter: show only one group's markers and areas, and fit the map to them
  var currentFilter = null;
  function visible(m) { return !currentFilter || m.group === currentFilter; }
  function fitVisible() {
    var pts = [[d.home.lat, d.home.lon]];
    d.markers.forEach(function(m) { if (visible(m)) pts.push([m.lat, m.lon]); });
    if (pts.length > 1) map.fitBounds(pts, { padding: [30, 30], maxZoom: 13 });
    else map.setView([d.home.lat, d.home.lon], d.zoom);
  }
  function applyFilter(group, refit) {
    currentFilter = group || null;
    map.closePopup();
    d.markers.forEach(function(m, idx) {
      var show = visible(m);
      [markerRefs[idx]].concat(polyRefs[idx] || []).forEach(function(layer) {
        if (!layer) return;
        if (show && !map.hasLayer(layer)) layer.addTo(map);
        if (!show && map.hasLayer(layer)) map.removeLayer(layer);
      });
    });
    if (refit) fitVisible();
  }

  // Radio links in popups: ask the widget to open them (the map frame can't open the browser)
  document.addEventListener('click', function(e) {
    var a = e.target.closest && e.target.closest('a[data-url]');
    if (!a) return;
    e.preventDefault();
    window.parent.postMessage({ type: 'openUrl', url: a.getAttribute('data-url') }, '*');
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
      fitVisible();
    }
    if (e.data && e.data.type === 'filter') {
      applyFilter(e.data.group, true);
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

  // Auto-fit bounds if incidents exist (warning areas covering home: fit the area)
  if (d.markers.length > 0) {
    var points = [[d.home.lat, d.home.lon]];
    d.markers.forEach(function(m) {
      points.push([m.lat, m.lon]);
      if (m.inside) (m.polygons || []).forEach(function(r) { r.forEach(function(pt) { points.push(pt); }); });
    });
    map.fitBounds(points, { padding: [30, 30], maxZoom: 13 });
  }
  if (d.filter) applyFilter(d.filter, true);
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
  quake:            { label: "Quake",     emoji: "\uD83C\uDF0F", colour: "#A1887F" },
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
  let alertedBefore = null;
  try {
    const envelope = JSON.parse(output);
    if (envelope.config) cfg = { ...DEFAULTS, ...envelope.config };
    feedData = envelope.feed || {};
    quakeData = envelope.quakes || null;
    alertedBefore = envelope.alerted || null;
  } catch (e) {
    // Fallback: treat entire output as feed (first run before config exists)
    try { feedData = JSON.parse(output); } catch (e2) { feedData = { error: true }; }
  }

  const { error, incidents, feedSource, feedUpdated, conditions } = parseFeed(feedData, cfg);
  if (!error) {
    incidents.push(...parseQuakes(quakeData, cfg));
    incidents.sort((a, b) => (b.homeInside ? 1 : 0) - (a.homeInside ? 1 : 0) || a.distance - b.distance);
  }
  const now = new Date();
  const hhmm = (d) => d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
  const updated = hhmm(now);
  const radio = pickRadio(cfg);
  const fire = error ? null : fireInfo(conditions, cfg);
  for (const inc of incidents) inc.cfaRadio = cfaRadio(inc);
  const insideWarnings = incidents.filter((i) => i.homeInside);

  // Feed health: when VicEmergency last published, and which feeds failed
  const feedTime = feedUpdated ? new Date(feedUpdated) : null;
  const feedAgeMin = feedTime && !isNaN(feedTime) ? (now - feedTime) / 60000 : null;
  const feedStale = feedAgeMin !== null && feedAgeMin > 30;
  const quakeFeedDown = cfg.SHOW_EARTHQUAKES && !error && !(quakeData && Array.isArray(quakeData.features));
  const fireDown = !!(fire && fire.unavailable);
  const healthNotes = [
    feedSource !== "geojson" && !error ? `VicEmergency backup feed (${feedSource}) in use \u2014 no warning areas or fire danger` : null,
    feedStale ? `VicEmergency data is ${Math.round(feedAgeMin)} min old` : null,
    quakeFeedDown ? "Earthquake feed unavailable" : null,
    fireDown && feedSource === "geojson" ? "Fire danger rating unavailable" : null,
  ].filter(Boolean);
  const feedDotColour = error ? "#FF6B6B" : (feedSource !== "geojson" || feedStale ? "#FFC107" : "#4CAF50");

  // Alerts
  if (!error && cfg.ALERTS) {
    const { alerts, state } = collectAlerts(incidents, fire, cfg, alertedBefore);
    if (alerts.length > 0) sendAlerts(alerts, state, cfg);
  }

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
  // A filter on a group that no longer has incidents is dropped
  if (_groupFilter && !incidents.some((i) => i.group === _groupFilter)) _groupFilter = null;
  const shown = incidents;   // every incident is listed; the list scrolls

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

  // Category filter — click a chip to show only that group, click it again
  // (or an empty part of the widget, or the zone name) to show everything
  const applyGroupFilter = (widget) => {
    if (!widget) return;
    widget.classList.toggle('ve-filtering', !!_groupFilter);
    widget.querySelectorAll('.ve-chip').forEach((el) => {
      el.classList.toggle('ve-chip-selected', !!_groupFilter && el.dataset.group === _groupFilter);
      el.classList.toggle('ve-chip-dimmed', !!_groupFilter && el.dataset.group !== _groupFilter);
    });
    widget.querySelectorAll('.ve-incident').forEach((el) => {
      el.classList.toggle('ve-filtered-out', !!_groupFilter && el.dataset.group !== _groupFilter);
    });
    const bar = widget.querySelector('.ve-filter-bar');
    if (bar) {
      bar.style.display = _groupFilter ? 'flex' : 'none';
      const name = bar.querySelector('.ve-filter-name');
      if (name) name.textContent = _groupFilter ? (GROUP_META[_groupFilter] || {}).label || _groupFilter : '';
    }
    const iframe = widget.querySelector('.ve-map-iframe');
    if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'filter', group: _groupFilter }, '*');
    _lastClickedIdx = null;
  };

  const setGroupFilter = (e, group) => {
    e.stopPropagation();
    _groupFilter = group;
    applyGroupFilter(e.target.closest('.ve-widget'));
  };

  const clickChip = (e, group) => setGroupFilter(e, _groupFilter === group ? null : group);

  // Clicks on empty parts of the widget clear the filter; rows, map, links and controls keep it
  const clickWidget = (e) => {
    if (!_groupFilter) return;
    if (e.target.closest('.ve-chip, .ve-incident, .ve-map-container, .ve-settings, .ve-settings-btn, .ve-toggle, .ve-footer-link, .ve-nearest, .ve-inside, input, select')) return;
    setGroupFilter(e, null);
  };

  const resetMapView = () => {
    if (_groupFilter) {
      _groupFilter = null;
      applyGroupFilter(document.querySelector('.ve-widget'));
    }
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
      if (e.data && e.data.type === 'openUrl' && /^https:\/\/www\.broadcastify\.com\/listen\/feed\/\d+$/.test(e.data.url || "")) {
        run(`open '${e.data.url}'`);
      }
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
      ...cfg,
      HOME_LAT: parseFloat(val('lat')) || DEFAULTS.HOME_LAT,
      HOME_LON: parseFloat(val('lon')) || DEFAULTS.HOME_LON,
      RADIUS_KM: parseInt(val('radius')) || DEFAULTS.RADIUS_KM,
      ZONE_NAME: val('zone') || DEFAULTS.ZONE_NAME,
      MAP_HEIGHT: parseInt(val('height')) || DEFAULTS.MAP_HEIGHT,
      MAP_ZOOM: parseInt(val('zoom')) || DEFAULTS.MAP_ZOOM,
      MAP_THEME: val('theme') || DEFAULTS.MAP_THEME,
      SHOW_MAP: val('showmap') === "auto" ? "auto" : val('showmap') === "true",
      EXCLUDE_BURN_AREA: chk('burn'),
      HIDE_WHEN_CLEAR: chk('hide'),
      SHOW_EARTHQUAKES: chk('quakes'),
      QUAKE_MIN_MAG: isNaN(parseFloat(val('quakemag'))) ? DEFAULTS.QUAKE_MIN_MAG : parseFloat(val('quakemag')),
      QUAKE_MAX_AGE_H: parseInt(val('quakeage')) || DEFAULTS.QUAKE_MAX_AGE_H,
      ABC_STATION: val('abc') || "auto",
      FIRE_DISTRICT: val('district') || "auto",
      ALERTS: chk('alerts'),
      ALERT_LEVEL: val('alertlevel') || DEFAULTS.ALERT_LEVEL,
      ALERT_SOUND: chk('alertsound'),
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
      // Reload now with the new settings instead of waiting for the next 2-minute refresh
      run(`osascript -e 'tell application id "tracesOf.Uebersicht" to refresh widget id "vicemergency-jsx"' 2>/dev/null || osascript -e 'tell application id "tracesOf.Uebersicht" to refresh'`);
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

  const fireSevereToday = !!(fire && fire.today && (fire.today.tfb || ["EXTREME", "CATASTROPHIC"].includes(fire.today.rating)));
  if (cfg.HIDE_WHEN_CLEAR && incidents.length === 0 && !fireSevereToday) {
    return <div className="ve-hidden" />;
  }

  return (
    <div className={`ve-widget ${_collapsed ? "ve-collapsed" : ""} ${_groupFilter ? "ve-filtering" : ""}`} onClick={clickWidget}>
      {/* Header */}
      <div className="ve-header">
        <div className="ve-title-row">
          <div className="ve-title-group">
            <span className="ve-title" onClick={resetMapView}>{cfg.ZONE_NAME}</span>
            <span className="ve-count">
              {incidents.length === 0
                ? "No active incidents"
                : `${incidents.length} active incident${incidents.length !== 1 ? "s" : ""}`}
              <span className="ve-feed-dot" style={{ background: feedDotColour }}
                    title={[`VicEmergency feed: ${feedSource}${feedTime ? ", published " + hhmm(feedTime) : ""}`, ...healthNotes].join("\n")}></span>
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

        {insideWarnings.length > 0 && (
          <div className="ve-inside" onClick={() => panToIncident(insideWarnings[0].lat, insideWarnings[0].lon, 0)}>
            <span>{"\u26A0\uFE0F"}</span>
            <span>
              <strong>Your location is inside a warning area</strong>
              <span className="ve-inside-detail">
                {LEVEL_LABEL[insideWarnings[0].warningLevel] || "Warning"}{" \u2014 "}{insideWarnings[0].eventType || insideWarnings[0].category2 || insideWarnings[0].category1}
                {insideWarnings[0].action ? ` \u2014 ${insideWarnings[0].action}` : ""}
                {insideWarnings.length > 1 ? ` (+${insideWarnings.length - 1} more)` : ""}
              </span>
            </span>
          </div>
        )}

        {fire && (
          <div className="ve-fire" title={`${fire.district} fire weather district \u2014 click for CFA fire danger ratings`}
            onClick={(e) => { e.stopPropagation(); run(`open '${cfaFdrUrl(fire.district)}'`); }}>
            <span className="ve-fire-district">
              <FdrDial rating={fire.today && !fire.unavailable ? fire.today.rating : ""} />
              {fire.district}
            </span>
            {fire.unavailable && <span className="ve-fire-na">Fire danger unavailable</span>}
            {!fire.unavailable && fire.days.every((d) => !FDR_STYLE[d.rating] && !d.tfb) && (
              <span className="ve-fire-na">No fire danger rating issued</span>
            )}
            {!fire.unavailable && fire.days.some((d) => FDR_STYLE[d.rating] || d.tfb) && (
              <span className="ve-fire-days">
                {fire.days.map((day, i) => {
                  const st = FDR_STYLE[day.rating];
                  return (
                    <span key={day.date} className="ve-fire-day" title={`${dayLabel(day.date, i)} ${day.date}: ${st ? st.label : "No rating"}${day.tfb ? " \u2014 Total Fire Ban" : ""}`}>
                      <span className={st ? "ve-fdr" : "ve-fdr ve-fdr-none"} style={st ? { background: st.colour, color: st.text } : undefined}>
                        {dayLabel(day.date, i)} {st ? st.label.charAt(0) : "\u2013"}
                      </span>
                      {day.tfb && <span className="ve-tfb">TFB</span>}
                    </span>
                  );
                })}
              </span>
            )}
            {!fire.unavailable && fire.heat && (
              <span className="ve-health-alert ve-heat" title="Heat Health Alert for this district">{"\uD83C\uDF21\uFE0F"} {fire.heat}</span>
            )}
            {!fire.unavailable && fire.asthma && (
              <span className="ve-health-alert ve-asthma" title="Epidemic thunderstorm asthma forecast">Thunderstorm asthma: {fire.asthma}</span>
            )}
          </div>
        )}

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
            <div key={key} data-group={key}
                 className={`ve-chip ${active ? "ve-chip-active" : ""} ${_groupFilter === key ? "ve-chip-selected" : ""} ${_groupFilter && _groupFilter !== key ? "ve-chip-dimmed" : ""}`}
                 style={active ? { borderColor: meta.colour, color: meta.colour } : {}}
                 title={active ? (_groupFilter === key ? "Show all" : `Show only ${meta.label}`) : ""}
                 onClick={active ? (e) => clickChip(e, key) : undefined}>
              <span className="ve-chip-emoji">{meta.emoji}</span>
              <span className="ve-chip-count">{count}</span>
              <span className="ve-chip-label">{meta.label}</span>
            </div>
          );
        })}
      </div>

      <div className="ve-filter-bar" style={{ display: _groupFilter ? "flex" : "none" }}>
        <span>Showing <strong className="ve-filter-name">{_groupFilter ? (GROUP_META[_groupFilter] || {}).label : ""}</strong> only</span>
        <span className="ve-filter-clear" onClick={(e) => setGroupFilter(e, null)}>{"\u2715"} Show all</span>
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

          const openLink = (e) => { e.stopPropagation(); run(`open ${shq(inc.link)}`); };

          return (
            <div key={inc.id} data-group={inc.group} title={agencyName(inc.sourceOrg)}
                 className={`ve-incident ${inc.homeInside ? "ve-incident-inside" : ""} ${!inc.warningLevel && statusClass(inc.status) === "finished" ? "ve-incident-finished" : ""} ${_groupFilter && inc.group !== _groupFilter ? "ve-filtered-out" : ""}`}
                 onClick={() => panToIncident(inc.lat, inc.lon, idx)}>
              <div className="ve-dot" style={{ background: dot }} />
              <div className="ve-incident-body">
                <div className="ve-incident-title">{displayTitle}</div>
                <div className="ve-incident-meta">
                  <span style={{ color: gm.colour || "#999" }}>{displayCat}</span>
                  {displayStatus && <span className="ve-incident-status">{displayStatus}</span>}
                  {inc.action && <span className="ve-incident-action">{inc.action}</span>}
                </div>
                {inc.advice && <div className="ve-incident-advice">{inc.advice}</div>}
                {(inc.link || inc.cfaRadio) && (
                  <div className="ve-incident-links">
                    {inc.link && (
                      <span className="ve-incident-link" onClick={openLink}>
                        {isWarning ? "Full warning \u2197" : "More info \u2197"}
                      </span>
                    )}
                    {inc.cfaRadio && (
                      <span className="ve-incident-link" title="CFA dispatch radio for this district (Broadcastify)"
                            onClick={(e) => { e.stopPropagation(); run(`open '${inc.cfaRadio.url}'`); }}>
                        {"\uD83C\uDFA7"} CFA District {inc.cfaRadio.district} radio
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="ve-incident-right">
                {inc.resources > 0 && <span className="ve-incident-resources">{"\uD83D\uDE92"} {inc.resources}</span>}
                <span className="ve-incident-dist">{inc.homeInside ? "here" : `${inc.distance} km`}</span>
                {inc.issued && <span className="ve-incident-time" title={inc.warningLevel ? "Issued" : "Last updated"}>{whenText(inc.issued)}</span>}
              </div>
            </div>
          );
        })}

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

          <label>Quake max age (h)</label>
          <input id="ve-cfg-quakeage" type="number" min="1" max="168" defaultValue={cfg.QUAKE_MAX_AGE_H} />

          <label>ABC radio station</label>
          <select id="ve-cfg-abc" defaultValue={cfg.ABC_STATION || "auto"}>
            <option value="auto">Auto (from location)</option>
            {Object.entries(ABC_STATIONS).map(([slug, name]) => <option key={slug} value={slug}>{name}</option>)}
          </select>

          <label>Fire district</label>
          <select id="ve-cfg-district" defaultValue={cfg.FIRE_DISTRICT || "auto"}>
            <option value="auto">Auto (from location)</option>
            {FIRE_DISTRICTS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>

          <label>Alerts</label>
          <input id="ve-cfg-alerts" type="checkbox" defaultChecked={cfg.ALERTS} />

          <label>Alert from level</label>
          <select id="ve-cfg-alertlevel" defaultValue={cfg.ALERT_LEVEL}>
            <option value="advice">Advice</option>
            <option value="watch_and_act">Watch and Act</option>
            <option value="emergency_warning">Emergency Warning</option>
          </select>

          <label>Alert sound</label>
          <input id="ve-cfg-alertsound" type="checkbox" defaultChecked={cfg.ALERT_SOUND} />

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
        <span className="ve-updated" title={`Widget refreshed ${updated}`}>
          {healthNotes.length > 0 && <span className="ve-health" title={healthNotes.join("\n")}>{"\u26A0\uFE0F"} </span>}
          {feedTime ? `VicEmergency ${hhmm(feedTime)}` : `Updated ${updated}`}
        </span>
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
    grid-template-columns: repeat(4, 1fr);
    gap: 5px;
    margin-bottom: 12px;
  }

  .ve-chip {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 6px 6px;
    border-radius: 8px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.06);
    color: #636366;
    font-size: 11px;
    transition: all 0.2s ease;
  }

  .ve-chip-active { cursor: pointer; }
  .ve-chip-active:hover { background: rgba(255,255,255,0.10); }
  .ve-chip-selected { background: rgba(255,255,255,0.14) !important; box-shadow: inset 0 0 0 1px currentColor; }
  .ve-chip-dimmed { opacity: 0.4; }

  .ve-incident.ve-filtered-out { display: none !important; }

  .ve-filter-bar {
    justify-content: space-between;
    align-items: center;
    margin: -4px 0 8px;
    font-size: 11px;
    color: #8E8E93;
  }
  .ve-filter-bar strong { color: #E0E0E0; }
  .ve-filter-clear { color: #4A90D9; cursor: pointer; }
  .ve-filter-clear:hover { color: #7DB3F0; }
  .ve-collapsed .ve-filter-bar { display: none !important; }

  .ve-chip-active {
    background: rgba(255,255,255,0.06);
    border-color: currentColor;
  }

  .ve-chip-emoji { font-size: 12px; }
  .ve-chip-count { font-weight: 700; font-size: 13px; min-width: 10px; }
  .ve-chip-label { font-size: 10px; opacity: 0.8; }

  /* The list scrolls on its own so the map below always stays on screen */
  .ve-list {
    margin-bottom: 10px;
    max-height: min(38vh, 340px);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-right: 2px;
  }
  .ve-list::-webkit-scrollbar { width: 6px; }
  .ve-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border-radius: 3px; }
  .ve-list::-webkit-scrollbar-track { background: transparent; }

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
  .ve-incident-action { color: #FFC107; }

  .ve-incident-advice {
    font-size: 11px;
    color: #A1A1A6;
    margin-top: 3px;
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .ve-incident-link {
    display: inline-block;
    font-size: 11px;
    color: #4A90D9;
    margin-top: 2px;
    cursor: pointer;
  }
  .ve-incident-link:hover { color: #7DB3F0; }
  .ve-incident-links { display: flex; flex-wrap: wrap; gap: 2px 12px; }

  .ve-incident-inside { background: rgba(213,0,0,0.10); }
  .ve-incident-finished { opacity: 0.55; }
  .ve-incident-time { font-size: 10px; color: #636366; white-space: nowrap; }

  .ve-inside {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin-top: 10px;
    padding: 8px 10px;
    border-radius: 8px;
    background: rgba(213,0,0,0.18);
    border: 1px solid rgba(255,82,82,0.5);
    color: #FFFFFF;
    font-size: 12px;
    cursor: pointer;
  }
  .ve-inside strong { display: block; }
  .ve-inside-detail { display: block; font-size: 11px; color: #FFCDD2; margin-top: 1px; }

  .ve-fire {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
    margin-top: 10px;
    font-size: 11px;
    color: #8E8E93;
  }
  .ve-fire-district { color: #C7C7CC; font-weight: 600; display: inline-flex; align-items: center; gap: 5px; }
  .ve-dial { flex-shrink: 0; }
  .ve-fire { cursor: pointer; }
  .ve-fire-days { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  .ve-fire-day { display: inline-flex; align-items: center; gap: 3px; }
  .ve-fire-label { color: #8E8E93; }
  .ve-fdr { padding: 1px 7px; border-radius: 10px; font-weight: 700; font-size: 10px; white-space: nowrap; }
  .ve-fdr-none { background: rgba(255,255,255,0.06); color: #8E8E93; font-weight: 500; }
  .ve-fire-na { color: #8E8E93; }
  .ve-health-alert { padding: 1px 7px; border-radius: 10px; font-size: 10px; font-weight: 600; }
  .ve-heat { background: rgba(229,57,53,0.18); color: #FF8A80; }
  .ve-asthma { background: rgba(171,71,188,0.20); color: #E1BEE7; }
  .ve-tfb { padding: 1px 6px; border-radius: 4px; background: #D50000; color: #FFFFFF; font-weight: 700; font-size: 10px; }
  .ve-health { cursor: help; }

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
