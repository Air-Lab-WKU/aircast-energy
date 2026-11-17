/* U.S. states outline from the vendored us-atlas 3.0.1 states-albers-10m TopoJSON (already projected to
   d3.geoAlbersUsa().scale(1300).translate([487.5, 305]), 975 x 610), plus that same projection for the
   lower 48 so BA centroids land on the outline. Hand-written to avoid shipping d3-geo/topojson-client. */
(function () {
  'use strict';
  const FC = window.FC;

  // --- minimal TopoJSON -> SVG path (polygons only, quantized arcs) ---
  function decodeArcs(topo) {
    const t = topo.transform;
    return topo.arcs.map((arc) => {
      let x = 0, y = 0;
      return arc.map((p) => {
        if (t) { x += p[0]; y += p[1]; return [x * t.scale[0] + t.translate[0], y * t.scale[1] + t.translate[1]]; }
        return p;
      });
    });
  }
  function ringPath(ring, arcs) {
    const pts = [];
    ring.forEach((i, k) => {
      let a = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
      if (k > 0) a = a.slice(1);
      for (const p of a) pts.push(p);
    });
    return 'M' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L') + 'Z';
  }
  function geomPath(g, arcs) {
    if (g.type === 'Polygon') return g.arcs.map((r) => ringPath(r, arcs)).join('');
    if (g.type === 'MultiPolygon') return g.arcs.map((poly) => poly.map((r) => ringPath(r, arcs)).join('')).join('');
    return '';
  }
  FC.loadStates = async function () {
    const r = await fetch('vendor/us-atlas-3.0.1-states-albers-10m.json');
    if (!r.ok) throw new Error('Map outline missing (vendor/us-atlas-3.0.1-states-albers-10m.json).');
    const topo = await r.json();
    const arcs = decodeArcs(topo);
    return topo.objects.states.geometries.map((g) => ({ name: g.properties && g.properties.name, d: geomPath(g, arcs) }));
  };

  // --- approximate BA service areas (tools/make_footprints.py), already projected to the same 975 x 610 frame ---
  // Same-origin relative path; any failure returns null and the caller falls back to the dot map.
  FC.loadFootprints = async function () {
    try {
      const r = await fetch('geo/ba_footprints.json');
      if (!r.ok) return null;
      const g = await r.json();
      if (!g || typeof g.bas !== 'object' || !Array.isArray(g.order)) return null;
      const okPath = (d) => typeof d === 'string' && /^[Mml0-9.,\sz-]+$/.test(d);
      const bas = {};
      g.order.forEach((k) => {
        const b = g.bas[k];
        if (b && okPath(b.path) && isFinite(b.cx) && isFinite(b.cy)) bas[k] = { path: b.path, cx: +b.cx, cy: +b.cy, area: +b.area || 0, name: String(b.name || '') };
      });
      const order = g.order.filter((k) => bas[k]);
      if (!order.length) return null;
      const context = (Array.isArray(g.context) ? g.context : []).filter((c) => c && okPath(c.path)).map((c) => ({ path: c.path, name: String(c.name || '') }));
      return { bas, order, context };
    } catch (e) { return null; }
  };

  // --- d3.geoAlbersUsa lower-48 branch: conicEqualArea, parallels 29.5/45.5, rotate [96,0], center [-0.6,38.7] ---
  const RAD = Math.PI / 180;
  const phi0 = 29.5 * RAD, phi1 = 45.5 * RAD;
  const sy0 = Math.sin(phi0), n = (sy0 + Math.sin(phi1)) / 2;
  const c = 1 + sy0 * (2 * n - sy0), r0 = Math.sqrt(c) / n;
  function raw(lam, phi) {
    const r = Math.sqrt(c - 2 * n * Math.sin(phi)) / n;
    const x = lam * n;
    return [r * Math.sin(x), r0 - r * Math.cos(x)];
  }
  const K = 1300, TX = 487.5, TY = 305;
  const cen = raw(-0.6 * RAD, 38.7 * RAD); // center is applied unrotated, as in d3
  const DX = TX - K * cen[0], DY = TY + K * cen[1];
  FC.project = function (lon, lat) {
    let lam = (lon + 96) * RAD;
    if (lam > Math.PI) lam -= 2 * Math.PI; else if (lam < -Math.PI) lam += 2 * Math.PI;
    const p = raw(lam, lat * RAD);
    return [DX + K * p[0], DY - K * p[1]];
  };
})();
