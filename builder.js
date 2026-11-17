// Builds the Anchorage trail database from public data, entirely in the browser:
//   trails  : OpenStreetMap (Overpass API), clipped to the Municipality of Anchorage boundary
//   heights : Mapzen/AWS Terrain Tiles (terrarium PNGs, public domain sources incl. USGS 3DEP)
// Output: GeoJSON FeatureCollection with Name, Label, Trail_Type, OSM_ids and Z elevations,
// in the same shape the planner's parseGeoJSON() reads.
async function buildAnchorageTrails(progress = () => {}, opts = {}) {
  const BBOX = [60.90, -150.05, 61.50, -148.95]; // S, W, N, E: Anchorage Bowl, Eagle River/Chugiak/Eklutna, Girdwood, Chugach front
  const MIRRORS = opts.mirrors || ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
  const q = `[out:json][timeout:300][maxsize:1073741824][bbox:${BBOX.join(',')}];
(way["highway"~"^(path|footway|track|bridleway|cycleway|steps)$"]["footway"!~"^(sidewalk|crossing|access_aisle|traffic_island|link)$"]["access"!~"^(private|no)$"]["area"!="yes"]["indoor"!="yes"];
 way["highway"~"^(path|footway|track|bridleway|cycleway|steps)$"]["footway"!~"^(sidewalk|crossing|access_aisle|traffic_island|link)$"]["access"~"^(private|no)$"]["foot"~"^(yes|designated|permissive)$"]["area"!="yes"];
 way["piste:type"="nordic"]["area"!="yes"];
 way["highway"~"^(footway|path|cycleway)$"]["footway"~"^(sidewalk|crossing|traffic_island|link|access_aisle)$"]["access"!~"^(private|no)$"]["area"!="yes"]["indoor"!="yes"];
 way["highway"~"^(residential|unclassified|tertiary|secondary|primary|living_street|pedestrian|tertiary_link|secondary_link|primary_link|service)$"]["service"!~"^(parking_aisle|drive-through|driveway|emergency_access)$"]["access"!~"^(private|no)$"]["area"!="yes"];);
out tags geom qt;
rel["wikidata"="Q39450"]["boundary"="administrative"];
out geom;`;

  // ---- 1. download from the first Overpass mirror that answers with JSON
  let osm = null, lastErr = '';
  for (const url of MIRRORS) {
    const host = new URL(url).host;
    progress(`Downloading trails from OpenStreetMap (${host})… this can take a minute or two`);
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 300000);
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ac.signal });
      const tx = await r.text();
      if (!r.ok || tx[0] !== '{') throw new Error(`${host}: ${r.status} ${tx.slice(0, 60).replace(/\s+/g, ' ')}`);
      osm = JSON.parse(tx); if (osm.remark && /error|timed out/i.test(osm.remark)) throw new Error(`${host}: ${osm.remark}`);
      break;
    } catch (e) { lastErr = e.name === 'AbortError' ? `${host}: timed out` : e.message; }
    finally { clearTimeout(timer); }
  }
  if (!osm) throw new Error('No OpenStreetMap server answered (' + lastErr + '). Try again in a few minutes.');
  return processAnchorageOSM(osm, progress, opts);
}
async function processAnchorageOSM(osm, progress = () => {}, opts = {}) {
  const ways = osm.elements.filter(e => e.type === 'way' && e.geometry && e.geometry.length > 1);
  const boundary = osm.elements.find(e => e.type === 'relation');

  // ---- 2. clip to the municipality: even-odd test against every outer/inner boundary segment
  let inside = () => true;
  if (boundary) {
    const segs = [];
    for (const m of boundary.members || []) if (m.type === 'way' && m.geometry && (m.role === 'outer' || m.role === 'inner'))
      for (let i = 1; i < m.geometry.length; i++) segs.push([m.geometry[i - 1].lon, m.geometry[i - 1].lat, m.geometry[i].lon, m.geometry[i].lat]);
    if (segs.length > 100) inside = (lon, lat) => { let c = false; for (const [x1, y1, x2, y2] of segs) if ((y1 > lat) !== (y2 > lat) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) c = !c; return c; };
  }

  // ---- 3. classify
  const PAVED = /^(asphalt|paved|concrete|concrete:plates|concrete:lanes|paving_stones|chipseal|metal|wood)$/;
  const WIDE = /^(gravel|fine_gravel|compacted|pebblestone|unpaved)$/;
  const LINKWALK = /^(sidewalk|crossing|traffic_island|link|access_aisle)$/;
  const nameOf = t => (t.name || t['piste:name'] || t.official_name || t.alt_name || (LINKWALK.test(t.footway || '') ? (t.footway === 'crossing' ? 'Crosswalk' : 'Sidewalk') : '')).trim();
  const ROAD = /^(residential|unclassified|tertiary|secondary|primary|living_street|pedestrian|tertiary_link|secondary_link|primary_link|service)$/;
  function typeOf(t) {
    if (t['piste:type'] === 'nordic') return 'Ski_trails';
    if (ROAD.test(t.highway || '') || LINKWALK.test(t.footway || '')) return 'Roads';   // link-only: the planner routes along streets between trails but never selects them
    if (t.highway === 'bridleway') return 'Horse_trails';
    if (t.highway === 'steps') return 'Neighborhood_paths';
    const s = t.surface || '';
    if (t.highway === 'track' || WIDE.test(s)) return 'Wide_trails';
    if (PAVED.test(s) || (t.highway === 'cycleway' && !s)) return nameOf(t) ? 'Paved_trails' : 'Neighborhood_paths';
    if (t.highway === 'footway' && !s) return 'Neighborhood_paths';
    return 'Singletrack';
  }
  const kept = [];
  for (const w of ways) {
    const g = w.geometry, mid = g[g.length >> 1];
    if (!inside(mid.lon, mid.lat)) continue;
    const t = w.tags || {};
    if (t.proposed || t.construction || /\b(planned|proposed|future)\b/i.test(nameOf(t))) continue;
    kept.push({ id: w.id, name: nameOf(w.tags || {}), type: typeOf(w.tags || {}), pts: g.map(p => [+p.lon.toFixed(7), +p.lat.toFixed(7)]) });
  }
  progress(`Got ${kept.length.toLocaleString()} trail lines. Joining them into trails…`);

  // ---- 4. join connected ways that share a name and type into one trail (so "whole trail" works)
  const key = p => p[0] + ',' + p[1];
  const par = kept.map((_, i) => i), fd = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const byPt = new Map();
  kept.forEach((w, i) => { if (!w.name) return; for (const p of w.pts) { const k = w.name + '|' + w.type + '|' + key(p); const j = byPt.get(k); if (j === undefined) byPt.set(k, i); else par[fd(i)] = fd(j); } });
  const groups = new Map(); kept.forEach((w, i) => { const r = fd(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(w); });

  // ---- 5. elevations from terrain tiles (zoom 13 ≈ 9 m pixels here), bilinear sampled
  const Z = opts.zoom || 13, N = 2 ** Z, TS = 256;
  const tileXY = (lon, lat) => { const r = lat * Math.PI / 180; return [(lon + 180) / 360 * N * TS, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N * TS]; };
  const need = new Set();
  for (const w of kept) for (const p of w.pts) { const [px, py] = tileXY(p[0], p[1]);
    for (const dx of [-1, 1]) for (const dy of [-1, 1]) need.add(Math.floor((px + dx) / TS) + '/' + Math.floor((py + dy) / TS)); }
  const tiles = new Map(), list = [...need]; let done = 0;
  const cv = document.createElement('canvas'); cv.width = cv.height = TS; const cx = cv.getContext('2d', { willReadFrequently: true });
  async function getTile(k) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const [x, y] = k.split('/');
        const img = new Image(); img.crossOrigin = 'anonymous';
        img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`;
        await img.decode(); cx.clearRect(0, 0, TS, TS); cx.drawImage(img, 0, 0);
        const d = cx.getImageData(0, 0, TS, TS).data, h = new Float32Array(TS * TS);
        for (let i = 0; i < TS * TS; i++) h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
        tiles.set(k, h); return;
      } catch (e) { await new Promise(r => setTimeout(r, 500 * (attempt + 1))); }
    }
  }
  for (let i = 0; i < list.length; i += 12) {
    await Promise.all(list.slice(i, i + 12).map(getTile)); done = Math.min(list.length, i + 12);
    progress(`Adding elevations: terrain tile ${done} of ${list.length}`);
  }
  const hAt = (gx, gy) => { const tx = Math.floor(gx / TS), ty = Math.floor(gy / TS), t = tiles.get(tx + '/' + ty); if (!t) return NaN;
    return t[(gy - ty * TS) * TS + (gx - tx * TS)]; };
  const elev = (lon, lat) => { const [px, py] = tileXY(lon, lat), x = px - 0.5, y = py - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), u = x - x0, v = y - y0;
    const a = hAt(x0, y0), b = hAt(x0 + 1, y0), c = hAt(x0, y0 + 1), d = hAt(x0 + 1, y0 + 1);
    const z = a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v; return Number.isFinite(z) ? +z.toFixed(1) : null; };
  const missing = list.length - tiles.size;

  // ---- 6. GeoJSON
  const features = [];
  for (const g of groups.values()) {
    const parts = g.map(w => w.pts.map(p => { const z = elev(p[0], p[1]); return [p[0], p[1], z == null ? 0 : z]; }));
    features.push({ type: 'Feature', properties: { Name: g[0].name || null, Label: null, Trail_Type: g[0].type, OSM_ids: g.map(w => w.id).join(',') },
      geometry: parts.length === 1 ? { type: 'LineString', coordinates: parts[0] } : { type: 'MultiLineString', coordinates: parts } });
  }
  features.sort((a, b) => (a.properties.Name || '~').localeCompare(b.properties.Name || '~'));
  const meta = { built: new Date().toISOString(), osm_base: osm.osm3s && osm.osm3s.timestamp_osm_base, ways: kept.length, trails: features.length,
    terrain_tiles: list.length, terrain_missing: missing, source: 'OpenStreetMap contributors (ODbL); elevations: AWS Terrain Tiles' };
  progress(`Built ${features.length.toLocaleString()} trails from ${kept.length.toLocaleString()} OpenStreetMap lines.`);
  return { type: 'FeatureCollection', metadata: meta, features };
}
