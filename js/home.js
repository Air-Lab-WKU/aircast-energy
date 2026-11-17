/* Home: plain-language headline for the chosen date, living US map, date scrubber with time-lapse,
   "what stands out", and the day-by-day table. Peak demand only (energy has no probabilities). */
(function () {
  'use strict';
  const FC = window.FC, h = FC.h, s = FC.s;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');

  const st = {
    issue: null, entry: null, summary: null, risk: null, states: null, obs: null,
    th: ['90', '95', '99'].includes(FC.params.get('th')) ? FC.params.get('th') : '90',
    target: 'peak', li: 0,
    sort: { col: 'max', dir: -1 },
    map: null, playing: 0,
    geo: null,            // approximate BA service areas; null -> dot map
    det: null,            // per-BA forecast rows (median, ranges, levels), keyed by lead
    col: FC.params.get('col') === 'rel' ? 'rel' : 'p',   // map colour: chance, or median vs level
    vals: FC.params.get('vals') === '1',                 // print median MW on the map
    hoverBa: null,
  };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    let L;
    try { L = await FC.loadIssues(); } catch (e) { return fail(e); }
    st.entry = L.cur; st.issue = FC.safeIssue(L.cur.issue);
    FC.issueMenu(FC.$('#issueMenu'), L.issues, L.cur, (iss) => 'index.html?issue=' + encodeURIComponent(iss));
    try {
      const [summary, risk, states, geo] = await Promise.all([
        FC.getJSON(st.issue + '/summary.json'),
        FC.getJSON(st.issue + '/risk.json'),
        FC.loadStates().catch(() => null),
        FC.loadFootprints().catch(() => null),
      ]);
      st.summary = summary; st.risk = risk; st.states = states; st.geo = geo;
    } catch (e) { return fail(e); }
    FC.checkStale(st.summary, L);

    const pt = probTargets();
    if (!pt.includes(st.target)) st.target = pt[0] || 'peak';
    st.li = indexFromHash();

    renderHeader();
    buildControls();
    renderLegend();
    if (!st.states) FC.$('#mapWrap').prepend(h('p', { class: 'note note-warn', role: 'status' }, 'The state outline could not be loaded; dots are drawn without it.'));
    FC.$('#mapGeoNote').hidden = !st.geo;
    if (st.geo) FC.$('#mapAltLead').textContent = 'Select an area, or a dot for the smallest ones, to open its full forecast.';
    buildMap();
    buildScrubber();
    initIntro();
    initPlay();
    update();
    FC.onResize(FC.$('#mapWrap'), () => { buildMap(); updateMap(); updateScrubber(); });
    window.addEventListener('hashchange', () => { const i = indexFromHash(); if (i !== st.li) setLead(i); });

    loadDetails();
  }

  function fail(e) {
    FC.errorBox(FC.$('#notes'), e);
    FC.$('#hero-title').textContent = 'The forecast could not be loaded';
    FC.$('#mapTitle').textContent = '';
    FC.$('#notable').replaceChildren();
    FC.$('#riskScroll').replaceChildren(h('p', { class: 'loading', text: 'No data.' }));
  }

  /* ---------- data helpers ---------- */
  function probTargets() {
    const r = st.risk;
    const list = Array.isArray(r.prob_targets) ? r.prob_targets : Object.keys(r.cells || {});
    return list.filter((t) => r.cells && r.cells[t] && Object.values(r.cells[t]).some((row) => row && row.some((v) => v != null)));
  }
  const leads = () => st.risk.leads;
  const leadAt = (i) => leads()[i];
  function cellsFor(th) {
    th = th || st.th;
    const key = th === '90' ? 'cells' : 'cells_p' + th;
    return (st.risk[key] && st.risk[key][st.target]) || {};
  }
  function dates(i) { const ld = st.risk.lead_dates && st.risk.lead_dates[i]; return ld ? { a: ld[0], b: ld[1] } : { a: null, b: null }; }
  const isWk = (i) => FC.isWeek(leadAt(i));
  const flagOf = (ba) => FC.flagOf(st.summary, ba);
  const pOf = (ba, i) => { const row = cellsFor()[ba]; return row ? row[i] ?? null : null; };
  function bas() {
    // BA codes come from JSON and end up in fetch paths and hrefs: keep only plain identifiers
    const ok = (ba) => typeof ba === 'string' && ba && FC.safeId(ba) === ba;
    const list = (st.summary.bas || []).filter((b) => b && ok(b.ba));
    const known = new Set(list.map((b) => b.ba));
    (st.risk.bas || Object.keys(cellsFor())).forEach((ba) => { if (ok(ba) && !known.has(ba)) { known.add(ba); list.push({ ba, name: ba }); } });
    return list;
  }
  const reliable = () => bas().filter((b) => !flagOf(b.ba));
  // When-words for a lead: "Thursday 19 November" / "the week of 17–23 November"
  function whenWords(i, cap) {
    const d = dates(i);
    const t = isWk(i) ? 'the week of ' + FC.fmtRangeWords(d.a, d.b) : FC.fmtWords(d.a);
    return cap ? FC.cap(t) : t;
  }
  function whenShort(i) { const d = dates(i); return isWk(i) ? 'week of ' + FC.fmtRange(d.a, d.b) : FC.fmtDate(d.a); }
  const levelWords = () => ({ '90': 'top 10%', '95': 'top 5%', '99': 'top 1%' })[st.th];
  function dayStats(i) {
    const vals = reliable().map((b) => ({ b, p: pOf(b.ba, i) })).filter((x) => x.p != null).sort((a, b) => b.p - a.p);
    return { vals, max: vals.length ? vals[0].p : null, n35: vals.filter((x) => x.p >= 0.35).length, top: vals[0] };
  }

  /* ---------- demand values (median, ranges, level) from the per-BA files ---------- */
  function valOf(ba, i) {
    const d = st.det && st.det[ba], r = d && d[leadAt(i)];
    if (!r || !r.q) return null;
    const q = (k) => (r.q[k] != null && isFinite(r.q[k]) ? +r.q[k] : null);
    const t = r.t && r.t[st.th] != null && isFinite(r.t[st.th]) ? +r.t[st.th] : null;
    const med = q('50');
    return { med, q25: q('25'), q75: q('75'), q05: q('05'), q95: q('95'), t, rel: med != null && t ? med / t : null };
  }
  // closeness of the median to the chosen level: its own sequential (blue) ramp, 7 steps
  const REL_EDGES = [0.75, 0.85, 0.9, 0.95, 1.0, 1.05];
  function relBin(v) {
    if (v == null || !isFinite(v)) return 'bna';
    let i = 0; while (i < REL_EDGES.length && v >= REL_EDGES[i]) i++;
    return 'c' + i;
  }
  const fmtRel = (v) => (v == null || !isFinite(v) ? '–' : Math.round(v * 100) + '%');
  const fmtMW = (v) => (v == null || !isFinite(v) ? '–' : v >= 10000 ? FC.fmt1(v / 1000) + ' GW' : FC.fmtNum(v) + ' MW');
  function relStats(i) {
    const vals = reliable().map((b) => ({ b, v: valOf(b.ba, i) })).filter((x) => x.v && x.v.rel != null).sort((a, b) => b.v.rel - a.v.rel);
    return { vals, top: vals[0], n100: vals.filter((x) => x.v.rel >= 1).length };
  }
  function relLegend() {
    const lab = ['under 75%', '75 to 85', '85 to 90', '90 to 95', '95 to 100', '100 to 105', '105% or more'];
    return h('div', { class: 'ramp', role: 'img', 'aria-label': `Colour scale for expected peak as a share of the ${levelWords()} level, in seven steps: ${lab.join(', ')}. Stronger blue means closer to or above the level.` },
      h('div', { class: 'ramp-bar', 'aria-hidden': 'true' }, lab.map((l, i) => h('span', { class: 'c' + i }))),
      h('div', { class: 'ramp-ticks', 'aria-hidden': 'true' }, [0].concat(REL_EDGES).map((t, k) => {
        const el = h('span', { text: k ? Math.round(t * 100) + (k === REL_EDGES.length ? '%' : '') : '' });
        el.style.setProperty('left', (k / 7) * 100 + '%');
        return el;
      })));
  }
  function renderLegend() {
    FC.$('#ramp').replaceChildren(st.col === 'rel' ? relLegend() : FC.rampLegend());
  }

  /* ---------- URL hash = chosen date ---------- */
  function indexFromHash() {
    const hs = decodeURIComponent(location.hash.slice(1));
    const ls = leads();
    if (/^\d{4}-\d{2}-\d{2}$/.test(hs)) { const i = ls.findIndex((k, j) => !FC.isWeek(k) && dates(j).a === hs); if (i >= 0) return i; }
    const m = /^week-?(\d+)$/i.exec(hs);
    if (m) { const i = ls.indexOf('w' + m[1]); if (i >= 0) return i; }
    const lead = FC.params.get('lead'); if (lead && ls.includes(lead)) return ls.indexOf(lead);
    return 0;
  }
  function writeHash() {
    const i = st.li, frag = isWk(i) ? 'week-' + leadAt(i).slice(1) : dates(i).a;
    const u = new URL(location.href);
    u.searchParams.set('issue', st.issue);
    if (st.th !== '90') u.searchParams.set('th', st.th); else u.searchParams.delete('th');
    u.searchParams.delete('lead');
    if (st.col === 'rel') u.searchParams.set('col', 'rel'); else u.searchParams.delete('col');
    if (st.vals) u.searchParams.set('vals', '1'); else u.searchParams.delete('vals');
    history.replaceState(null, '', u.pathname + u.search + '#' + frag);
  }

  /* ---------- header, intro, notable ---------- */
  function renderHeader() {
    const sm = st.summary;
    FC.$('#badges').replaceChildren(...FC.issueBadges(sm, st.entry));
    FC.$('#meta').replaceChildren(FC.metaList(sm));
    FC.$('#notes').replaceChildren(...FC.issueNotes(sm).filter((n) => !n.textContent.startsWith('Run caveat')));
    const cv = FC.$('#caveat');
    const bits = [];
    if (sm.kind === 'replay') bits.push(h('span', null, h('b', { text: 'Hindcast.' }), ` This run was re-made as if on ${FC.fmtWords(sm.issue, true)}, using only data available then. Dots show what actually happened.`));
    else bits.push(h('span', null, h('b', { text: 'Experimental.' }), ' ' + (sm.caveat ? FC.cap(String(sm.caveat)) + '.' : 'Research forecast, not tested in live use.') + ' ', h('a', { href: 'methods.html#limits', text: 'Known limits' })));
    if (sm.stale) bits.push(h('span', null, h('b', { text: 'Out of date.' }), ` No new run since ${FC.fmtWords(sm.stale_since || sm.issue)}; this is the last good one.`));
    cv.replaceChildren(...bits);
    document.title = `AirCast-Energy · Demand outlook ${FC.fmtLong(sm.issue)}${sm.kind === 'replay' ? ' (hindcast)' : ''} · AIR Lab · WKU`;
    renderNotable();
  }

  function initIntro() {
    const box = FC.$('#intro'), open = FC.$('#introOpen'), close = FC.$('#introClose');
    let seen = false;
    try { seen = localStorage.getItem('fc-intro-seen') === '1'; } catch (e) { /* ignore */ }
    const set = (on, focus) => {
      box.hidden = !on; open.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on && focus) box.querySelector('h2').setAttribute('tabindex', '-1'), box.querySelector('h2').focus();
    };
    set(!seen, false);
    open.addEventListener('click', () => set(box.hidden, true));
    close.addEventListener('click', () => { set(false); open.focus(); try { localStorage.setItem('fc-intro-seen', '1'); } catch (e) { /* ignore */ } });
  }

  // "What stands out": the strongest signal per area over the whole two weeks (top-10% level, peak)
  function renderNotable() {
    const ul = FC.$('#notable');
    const c90 = cellsFor('90');
    const rows = reliable().map((b) => {
      const row = c90[b.ba] || []; let best = -1, bi = -1, n50 = 0;
      row.forEach((v, i) => { if (v != null) { if (v > best) { best = v; bi = i; } if (v >= 0.5) n50++; } });
      return { b, p: best, i: bi, n50 };
    }).filter((r) => r.p >= 0.3).sort((a, b) => b.p - a.p).slice(0, 5);
    const kids = rows.map((r) => h('li', null,
      h('a', { href: FC.baHref(r.b.ba, st.issue) }, FC.cap(FC.place(r.b.ba))),
      ` ${FC.fmtPct(r.p)} chance (${FC.oneIn(r.p)}) of unusually high peak demand ${isWk(r.i) ? 'in the ' + whenWords(r.i) : 'on ' + whenWords(r.i)}` +
      (r.n50 > 1 ? `, with better-than-even odds on ${r.n50} of the ${leads().length} days and weeks shown.` : '.')));
    if (!kids.length) kids.push(h('li', null, 'Nothing unusual. No area has even a 30% chance of reaching its top-10% demand level in the next two weeks.'));
    const flagged = bas().filter((b) => flagOf(b.ba));
    if (flagged.length) kids.push(h('li', { class: 'muted' }, `Left out: ${FC.joinAnd(flagged.map((b) => FC.place(b.ba) + ' (' + b.ba + ')'))}, which have no live demand feed, so their numbers are not reliable.`));
    ul.replaceChildren(...kids);
  }

  /* ---------- headline for the chosen date ---------- */
  function renderHeadline() {
    const i = st.li, S = dayStats(i), replay = st.summary.kind === 'replay';
    const hi = S.vals.filter((x) => x.p >= 0.5), mid = S.vals.filter((x) => x.p >= 0.3);
    const names = (xs) => FC.joinAnd(xs.slice(0, 3).map((x) => FC.place(x.b.ba)));
    const when = isWk(i) ? 'In ' + whenWords(i) : 'On ' + whenWords(i);
    let title;
    if (hi.length > 3) title = replay ? `${when}, the forecast gave ${hi.length} areas high odds of unusually high demand, led by ${names(hi)}` : `${when}, ${hi.length} areas could see unusually high demand, led by ${names(hi)}`;
    else if (hi.length) title = replay ? `${when}, the forecast gave ${names(hi)} high odds of unusually high demand` : `${when}, ${names(hi)} could see unusually high demand`;
    else if (mid.length) title = `${when}, demand looks mostly ordinary, with ${names(mid)} worth watching`;
    else title = `${when}, demand looks ordinary in all ${S.vals.length} areas`;
    FC.$('#hero-title').textContent = title;

    const lede = [];
    if (S.top && S.top.p >= 0.3) {
      lede.push(`${FC.cap(FC.place(S.top.b.ba))} has a ${FC.fmtPct(S.top.p)} chance, ${FC.oneIn(S.top.p)}, that peak demand lands in its ${levelWords()} for the time of year. On an ordinary ${isWk(i) ? 'week' : 'day'} that chance is ${({ '90': '1 in 10', '95': '1 in 20', '99': '1 in 100' })[st.th]}.`);
    } else {
      lede.push(`No area is above a 30% chance of peak demand in its ${levelWords()} for the time of year. Highest: ${S.top ? FC.place(S.top.b.ba) + ' at ' + FC.fmtPct(S.top.p) : 'none'}.`);
    }
    const o = obsCount(i);
    if (o) lede.push(` What happened: ${o.n} of ${o.of} areas actually reached that level.`);
    FC.$('#heroLede').textContent = lede.join('');
  }

  /* ---------- controls ---------- */
  function seg(name, legend, opts, value, onChange) {
    return h('fieldset', { class: 'seg' }, h('legend', { text: legend }),
      h('div', { class: 'seg-row' }, opts.map((o) => h('label', null,
        h('input', { type: 'radio', name, value: o.v, checked: o.v === value, onchange: (e) => onChange(e.target.value) }),
        h('span', { text: o.l })))));
  }
  function buildControls() {
    const thOpts = [{ v: '90', l: 'Top 10%' }, { v: '95', l: 'Top 5%' }, { v: '99', l: 'Top 1%' }];
    ['map', 'tbl'].forEach((where) => {
      FC.$(where === 'map' ? '#mapControls' : '#tableControls').replaceChildren(
        seg('th-' + where, 'How unusual', thOpts, st.th, (v) => { st.th = v; FC.$$('input[name^="th-"]').forEach((x) => { x.checked = x.value === v; }); renderLegend(); update(); }));
    });
    FC.$('#mapControls').append(
      seg('col-map', 'Colour by', [{ v: 'p', l: 'Chance' }, { v: 'rel', l: 'Peak vs level' }], st.col, (v) => { st.col = v; renderLegend(); update(); }),
      h('fieldset', { class: 'seg' }, h('legend', { text: 'Values' }),
        h('div', { class: 'seg-row' }, h('label', null,
          h('input', { type: 'checkbox', name: 'vals-map', checked: st.vals, onchange: (e) => { st.vals = e.target.checked; update(); } }),
          h('span', { text: 'Show MW' })))));
    if (probTargets().length <= 1) FC.$('#riskNote').append(' Daily energy forecasts have ranges but no chances of this kind yet, so the map and this table show peak demand only; each area\'s page has its energy outlook.');
  }

  function setLead(i, opts) {
    i = Math.max(0, Math.min(leads().length - 1, i));
    if (i === st.li && !(opts && opts.force)) return;
    st.li = i;
    update();
  }
  function update() {
    renderHeadline();
    renderMapTitle();
    updateMap();
    updateScrubber();
    renderTable();
    writeHash();
  }

  function renderMapTitle() {
    const i = st.li, S = dayStats(i);
    if (st.col === 'rel') {
      const R = relStats(i);
      FC.$('#mapTitle').replaceChildren(
        h('span', { class: 'mt-when', text: whenWords(i, true) }),
        h('span', { class: 'mt-what', text: `Expected ${isWk(i) ? 'highest ' : ''}peak demand as a share of each area's ${levelWords()} level` }));
      FC.$('#rampCap').textContent = `Expected peak, % of the ${levelWords()} level`;
      FC.$('#mapRead').replaceChildren(
        h('strong', { text: whenWords(i, true) + ': ' }),
        !st.det ? 'loading demand values…' : R.top
          ? `${R.n100 ? R.n100 + ' of ' + R.vals.length + (R.n100 === 1 ? ' area expected at or above its level' : ' areas expected at or above their level') : 'no area expected at or above its level'}; ${R.n100 ? 'highest' : 'closest'} is ${FC.place(R.top.b.ba)} at ${fmtRel(R.top.v.rel)} (${fmtMW(R.top.v.med)}).`
          : 'no demand values.');
      return;
    }
    FC.$('#mapTitle').replaceChildren(
      h('span', { class: 'mt-when', text: whenWords(i, true) }),
      h('span', { class: 'mt-what', text: `Chance that ${isWk(i) ? 'the week\'s highest' : ''} peak demand lands in each area's ${levelWords()}`.replace('  ', ' ') }));
    FC.$('#rampCap').textContent = `Chance of reaching the ${levelWords()}`;
    FC.$('#mapRead').replaceChildren(
      h('strong', { text: whenWords(i, true) + ': ' }),
      S.n35 ? `${S.n35} of ${S.vals.length} areas at 35% or more` : `no area at 35% or more`,
      S.top ? `; highest is ${FC.place(S.top.b.ba)} at ${FC.fmtPct(S.top.p)} (${FC.oneIn(S.top.p)}).` : '.');
  }

  /* ---------- map ---------- */
  // Two renderers share nodes, labels and the tooltip: filled service areas (st.geo) or, as a fallback, dots.
  function buildMap() {
    const svg = FC.$('#map'), wrap = FC.$('#mapWrap');
    const scale = Math.max(0.2, (svg.clientWidth || wrap.clientWidth || 975) / 975);
    const hs = Math.max(5, 5.5 / scale);
    const defs = s('defs', null,
      s('pattern', { id: 'hatch', width: hs, height: hs, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
        s('rect', { width: hs, height: hs, class: 'bna' }), s('line', { x1: 0, y1: 0, x2: 0, y2: hs, 'stroke-width': Math.max(2, 1.6 / scale), class: 'hatch-l' })));
    if (st.geo) buildAreas(svg, scale, defs); else buildDots(svg, scale, defs);
    FC.$('#flagKey').hidden = !st.map.nodes.some((n) => n.flag);
    FC.$('#flagKey').classList.toggle('is-area', !!st.geo);
    FC.$('#ctxKey').hidden = !st.geo;
    hideTip();
  }

  function bindTip(el, n) {
    el.addEventListener('mouseenter', () => showTip(n));
    el.addEventListener('mouseleave', hideTip);
    el.addEventListener('focus', () => showTip(n));
    el.addEventListener('blur', hideTip);
  }
  const labelSpan = (fontPx) => (el) => { el.style.setProperty('font-size', fontPx + 'px'); el.style.setProperty('stroke-width', (fontPx * 0.3) + 'px'); return el; };

  function buildAreas(svg, scale, defs) {
    const G = st.geo, list = bas(), byBa = new Map(list.map((b) => [b.ba, b]));
    const r0 = Math.max(7, 6 / scale);              // point marker (no outline: SPPC)
    const rs = Math.max(4.5, 5 / scale);            // dot for areas too small to point at
    const small = (a) => a * scale * scale < 260;   // under ~260 px^2 on screen
    const fontPx = Math.max(12, 12.5 / scale);
    const kids = [defs];
    if (st.states) kids.push(s('g', { 'aria-hidden': 'true' }, st.states.map((g) => s('path', { class: 'land', d: g.d }))));
    kids.push(s('g', { 'aria-hidden': 'true', class: 'ctx' }, G.context.map((c) => s('path', { class: 'ctx-a', d: c.path }))));
    const nodes = [];
    // fills, largest first so nested and small areas sit on top; mouse targets only (keyboard uses the layer below)
    const gf = s('g', { class: 'areas' });
    G.order.forEach((code) => {
      const b = byBa.get(code), f = G.bas[code];
      if (!b) return;
      const n = { b, flag: flagOf(code), ax: f.cx, ay: f.cy, x: f.cx, y: f.cy, area: f.area, d: f.path, kind: small(f.area) ? 'small' : 'area' };
      n.fill = s('path', { class: 'ba-a', d: f.path });
      n.fa = s('a', { href: FC.baHref(code, st.issue), tabindex: '-1', 'aria-hidden': 'true', 'data-ba': code }, n.fill);
      n.fa.addEventListener('mouseenter', () => showTip(n));
      n.fa.addEventListener('mouseleave', hideTip);
      gf.appendChild(n.fa);
      nodes.push(n);
    });
    list.forEach((b) => {
      if (G.bas[b.ba] || !isFinite(b.lat) || !isFinite(b.lon)) return;
      const p = FC.project(+b.lon, +b.lat);
      nodes.push({ b, flag: flagOf(b.ba), ax: p[0], ay: p[1], x: p[0], y: p[1], area: 0, d: '', kind: 'pt' });
    });
    kids.push(gf);
    if (st.states) kids.push(s('g', { 'aria-hidden': 'true', class: 'borders' }, st.states.map((g) => s('path', { class: 'st-line', d: g.d }))));
    const hl = s('path', { class: 'ba-hl', d: '' });
    kids.push(s('g', { 'aria-hidden': 'true' }, hl));
    // dots for points and tiny areas, nudged apart; thin leader back to the true spot
    const dotted = nodes.filter((n) => n.kind !== 'area');
    dotted.forEach((n) => { n.r = n.kind === 'pt' ? r0 : rs; });
    relax(dotted, r0);
    nodes.forEach((n) => { if (n.kind === 'area') n.r = 0; });
    kids.push(s('g', { 'aria-hidden': 'true', class: 'leaders' }, dotted.filter((n) => Math.hypot(n.x - n.ax, n.y - n.ay) > n.r * 0.6)
      .map((n) => s('line', { class: 'leader', x1: n.ax, y1: n.ay, x2: n.x, y2: n.y }))));
    // keyboard and screen-reader layer: one link per area, west to east, as with the dots
    const gm = s('g', { class: 'markers' });
    nodes.slice().sort((a, b) => a.ax - b.ax).forEach((n) => {
      const dot = n.kind !== 'area';
      n.dot = s('circle', { class: dot ? 'mk' : 'mk-anchor', cx: n.x, cy: n.y, r: dot ? n.r : 1 });
      n.hit = s('circle', { class: 'hit-dot', cx: n.x, cy: n.y, r: dot ? Math.max(2.2, n.r * 0.4) : Math.max(3, 4 / scale) });
      n.focusR = dot ? s('circle', { class: 'mk-focus', cx: n.x, cy: n.y, r: n.r + Math.max(3, 3 / scale) }) : null;
      n.a = s('a', { href: FC.baHref(n.b.ba, st.issue), 'data-ba': n.b.ba }, n.dot,
        n.flag && n.kind === 'pt' ? s('circle', { class: 'flag', cx: n.x, cy: n.y, r: n.r + 3 }) : null, n.hit, n.focusR);
      bindTip(n.a, n);
      gm.appendChild(n.a);
    });
    kids.push(gm);
    const gl = s('g', { 'aria-hidden': 'true' });
    const style = labelSpan(fontPx);
    nodes.forEach((n) => { n.lbl = style(s('text', { class: 'mk-lbl', x: n.x, y: n.y, 'font-size': fontPx })); gl.appendChild(n.lbl); });
    kids.push(gl);
    svg.replaceChildren(...kids);
    st.map = { kind: 'areas', nodes, hl, fontPx, r0 };
  }

  function buildDots(svg, scale, defs) {
    const r0 = Math.max(7, 6 / scale);            // smallest dot, viewBox units
    const rMax = r0 * 1.55;                         // biggest dot (100%)
    const fontPx = Math.max(12, 12.5 / scale);
    const kids = [defs];
    if (st.states) kids.push(s('g', { 'aria-hidden': 'true' }, st.states.map((g) => s('path', { class: 'land', d: g.d }))));
    const nodes = bas().filter((b) => isFinite(b.lat) && isFinite(b.lon)).map((b) => {
      const p = FC.project(+b.lon, +b.lat); return { b, ax: p[0], ay: p[1], x: p[0], y: p[1], flag: flagOf(b.ba), kind: 'dot' };
    });
    relax(nodes, rMax);
    kids.push(s('g', { 'aria-hidden': 'true', class: 'leaders' }, nodes.filter((n) => Math.hypot(n.x - n.ax, n.y - n.ay) > r0 * 0.6)
      .map((n) => s('g', null, s('line', { class: 'leader', x1: n.ax, y1: n.ay, x2: n.x, y2: n.y }), s('circle', { cx: n.ax, cy: n.ay, r: Math.max(1.5, 1.6 / scale), fill: 'currentColor' })))));
    const gm = s('g', { class: 'markers' });
    nodes.slice().sort((a, b) => a.ax - b.ax).forEach((n) => {
      n.pulse = s('circle', { class: 'pulse', cx: n.x, cy: n.y, r: rMax });
      n.dot = s('circle', { class: 'mk', cx: n.x, cy: n.y, r: r0 });
      n.ring = s('circle', { class: 'mk-ring', cx: n.x, cy: n.y, r: r0 + 0.5 });
      n.hit = s('circle', { class: 'hit-dot', cx: n.x, cy: n.y, r: Math.max(2.2, r0 * 0.34) });
      n.focusR = s('circle', { class: 'mk-focus', cx: n.x, cy: n.y, r: rMax + 4 });
      n.a = s('a', { href: FC.baHref(n.b.ba, st.issue), 'data-ba': n.b.ba }, n.pulse, n.dot, n.ring, n.flag ? s('circle', { class: 'flag', cx: n.x, cy: n.y, r: r0 + 3 }) : null, n.hit, n.focusR);
      bindTip(n.a, n);
      gm.appendChild(n.a);
    });
    kids.push(gm);
    const gl = s('g', { 'aria-hidden': 'true' });
    const style = labelSpan(fontPx);
    nodes.forEach((n) => { n.lbl = style(s('text', { class: 'mk-lbl', x: n.x, y: n.y, 'font-size': fontPx })); gl.appendChild(n.lbl); });
    kids.push(gl);
    svg.replaceChildren(...kids);
    st.map = { kind: 'dots', nodes, r0, rMax, fontPx };
  }

  const colourOf = (n) => (n.flag ? null : st.col === 'rel' ? relBin(n.v && n.v.rel) : FC.bin(n.p));

  function updateMap() {
    if (!st.map) return;
    const M = st.map, i = st.li;
    M.nodes.forEach((n) => {
      n.p = pOf(n.b.ba, i); n.v = valOf(n.b.ba, i);
      const p = n.p, v = n.v, cls = colourOf(n);
      if (M.kind === 'dots') {
        const r = n.flag ? M.r0 : M.r0 + (M.rMax - M.r0) * Math.sqrt(Math.max(0, (st.col === 'rel' ? 0 : p) || 0));
        n.dot.style.setProperty('r', r + 'px');
        n.ring.style.setProperty('r', (r + 0.5) + 'px');
        n.pulse.classList.toggle('on', st.col === 'p' && !n.flag && p != null && p >= 0.5);
        n.r = r;
      }
      if (n.fill) {
        n.fill.setAttribute('class', 'ba-a' + (cls ? ' ' + cls : ''));
        if (n.flag) n.fill.setAttribute('fill', 'url(#hatch)'); else n.fill.removeAttribute('fill');
      }
      if (n.kind !== 'area') {
        n.dot.setAttribute('class', 'mk' + (cls ? ' ' + cls : ''));
        if (n.flag) n.dot.setAttribute('fill', 'url(#hatch)'); else n.dot.removeAttribute('fill');
      }
      const hit = obsHit(n.b.ba, i);
      n.hit.classList.toggle('on', hit === true);
      const href = FC.baHref(n.b.ba, st.issue) + '#' + (isWk(i) ? 'week-' + leadAt(i).slice(1) : dates(i).a);
      n.a.setAttribute('href', href);
      if (n.fa) n.fa.setAttribute('href', href);
      n.a.setAttribute('aria-label', `${FC.place(n.b.ba)}, ${n.b.ba}: ` + (n.flag ? 'no live demand feed, not reliable. ' : '') +
        (v && v.med != null ? `expected peak ${FC.fmtNum(v.med)} megawatts` + (v.t != null ? `, ${fmtRel(v.rel)} of its ${levelWords()} level of ${FC.fmtNum(v.t)}` : '') + '; ' : '') +
        `${FC.fmtPct(p)} chance, ${FC.oneIn(p)}, of peak demand in its ${levelWords()}, ${whenWords(i)}.` + (hit === true ? ' It happened.' : hit === false ? ' It did not happen.' : ''));
    });
    placeLabels();
    if (st.tipNode) showTip(st.tipNode);
  }

  function labelText(n) {
    let nm = FC.cap(FC.place(n.b.ba).replace(/^the /, ''));
    if (n.flag) return `${n.b.ba}, not reliable`;
    if (st.vals) {
      if (!n.v || n.v.med == null) return '';
      if (st.map.fontPx > 20) nm = n.b.ba;           // narrow screens: codes keep value labels short
      return `${nm} ${fmtMW(n.v.med)}`;
    }
    if (st.col === 'rel') return n.v && n.v.rel != null ? `${nm} ${fmtRel(n.v.rel)}` : '';
    return `${nm} ${FC.fmtPct(n.p)}`;
  }
  // Which areas get a direct label, in priority order (the hovered or focused one always goes first)
  function wantLabels() {
    const { nodes, kind } = st.map, ok = nodes.filter((n) => !n.flag);
    let want;
    if (st.vals) want = ok.filter((n) => n.v && n.v.med != null).sort((a, b) => (b.p ?? -1) - (a.p ?? -1) || (b.area || 0) - (a.area || 0));
    else if (st.col === 'rel') want = ok.filter((n) => n.v && n.v.rel != null && n.v.rel >= 0.95).sort((a, b) => b.v.rel - a.v.rel);
    else if (kind === 'areas') want = ok.filter((n) => n.p != null && n.p >= 0.35).sort((a, b) => b.p - a.p);
    else want = ok.filter((n) => n.p != null && n.p >= 0.2).sort((a, b) => b.p - a.p).slice(0, 5);
    // flagged areas are hatched with a legend key; on narrow maps their long labels would land on neighbours
    if (!(kind === 'areas' && st.map.fontPx > 20)) want = want.concat(nodes.filter((n) => n.flag));
    const hv = st.hoverBa && nodes.find((n) => n.b.ba === st.hoverBa);
    if (hv) want = [hv].concat(want.filter((n) => n !== hv));
    return want;
  }

  // Direct labels that never overlap a dot or another label: centre (areas), right, left, above, below; else drop
  function placeLabels() {
    const { nodes, fontPx: fs } = st.map;
    const boxes = nodes.filter((n) => n.r > 0).map((n) => ({ x0: n.x - n.r - 2, x1: n.x + n.r + 2, y0: n.y - n.r - 2, y1: n.y + n.r + 2 }));
    const hit = (b) => b.x0 < 2 || b.x1 > 973 || b.y0 < 2 || b.y1 > 608 || boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
    nodes.forEach((n) => { n.lbl.textContent = ''; n.lbl.classList.remove('is-hover'); });
    wantLabels().forEach((n) => {
      const txt = labelText(n);
      if (!txt) return;
      const w = txt.length * fs * 0.56, hgt = fs * 1.15, g = (n.r || 0) + 4;
      const opts = [];
      if (!n.r) opts.push({ x: n.x, y: n.y, a: 'middle', b: { x0: n.x - w / 2, x1: n.x + w / 2, y0: n.y - hgt / 2, y1: n.y + hgt / 2 } });
      opts.push(
        { x: n.x + g, y: n.y, a: 'start', b: { x0: n.x + g, x1: n.x + g + w, y0: n.y - hgt / 2, y1: n.y + hgt / 2 } },
        { x: n.x - g, y: n.y, a: 'end', b: { x0: n.x - g - w, x1: n.x - g, y0: n.y - hgt / 2, y1: n.y + hgt / 2 } },
        { x: n.x, y: n.y - g - hgt / 2, a: 'middle', b: { x0: n.x - w / 2, x1: n.x + w / 2, y0: n.y - g - hgt, y1: n.y - g } },
        { x: n.x, y: n.y + g + hgt / 2, a: 'middle', b: { x0: n.x - w / 2, x1: n.x + w / 2, y0: n.y + g, y1: n.y + g + hgt } });
      const ok = opts.find((o) => !hit(o.b));
      if (!ok) return;
      boxes.push(ok.b);
      n.lbl.textContent = txt;
      n.lbl.classList.toggle('is-hover', n.b.ba === st.hoverBa);
      n.lbl.setAttribute('x', ok.x); n.lbl.setAttribute('y', ok.y + fs * 0.36); n.lbl.setAttribute('text-anchor', ok.a);
    });
  }

  function relax(nodes, r) {
    const min = 2 * r + 2;
    for (let it = 0; it < 320; it++) {
      let moved = false;
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
        if (d < min) {
          if (d < 1e-3) { dx = 1; dy = 0.3 * ((i % 3) - 1); d = Math.hypot(dx, dy); }
          const push = (min - d) / 2, ux = dx / d, uy = dy / d;
          a.x -= ux * push; a.y -= uy * push; b.x += ux * push; b.y += uy * push; moved = true;
        }
      }
      // pull back towards the true spot, but stop pulling for the last iterations so no overlap remains
      if (it < 220) for (const n of nodes) { n.x += (n.ax - n.x) * 0.03; n.y += (n.ay - n.y) * 0.03; }
      if (!moved && it > 10) break;
    }
  }

  function tipRow(k, v) { return h('div', { class: 'tip-row' }, h('span', { text: k }), h('b', { text: v })); }
  function showTip(n) {
    const relabel = st.hoverBa !== n.b.ba;
    st.tipNode = n; st.hoverBa = n.b.ba;
    FC.$$('#map a.is-hover').forEach((x) => x.classList.remove('is-hover'));
    n.a.classList.add('is-hover');
    if (st.map.hl) st.map.hl.setAttribute('d', n.d || '');
    if (relabel) placeLabels();
    const tip = FC.$('#tip'), wrap = FC.$('#mapWrap'), b = n.b, v = n.v;
    const row = (cellsFor()[b.ba] || []).slice(0, leads().filter((k) => !FC.isWeek(k)).length);
    const spark = FC.spark(row, isWk(st.li) ? -1 : st.li, !!n.flag, { w: 220, h: 34 });
    spark.classList.add('tip-spark');
    const hit = obsHit(b.ba, st.li);
    const lvl = ({ '90': 'Top-10% level', '95': 'Top-5% level', '99': 'Top-1% level' })[st.th];
    const vals = v && v.med != null ? h('div', { class: 'tip-vals' },
      tipRow(isWk(st.li) ? 'Expected highest peak' : 'Expected peak', FC.fmtNum(v.med) + ' MW'),
      v.q25 != null && v.q75 != null ? tipRow('50% range', FC.fmtNum(v.q25) + '–' + FC.fmtNum(v.q75) + ' MW') : null,
      v.q05 != null && v.q95 != null ? tipRow('90% range', FC.fmtNum(v.q05) + '–' + FC.fmtNum(v.q95) + ' MW') : null,
      v.t != null ? tipRow(lvl, FC.fmtNum(v.t) + ' MW') : null,
      v.rel != null ? tipRow('Expected vs level', fmtRel(v.rel)) : null)
      : h('div', { class: 'tip-name', text: st.det ? 'No demand values for this date.' : 'Loading demand values…' });
    tip.replaceChildren(...[
      h('div', { class: 'tip-head' }, h('b', { text: FC.cap(FC.place(b.ba)) }), h('span', { class: 'tip-code', text: b.ba })),
      h('div', { class: 'tip-name', text: b.name || '' }),
      h('div', { class: 'tip-when', text: FC.cap(whenShort(st.li)) }),
      vals,
      h('div', { class: 'tip-p' }, h('strong', { text: FC.fmtPct(n.p) }), h('span', { text: FC.oneIn(n.p) })),
      h('div', { class: 'tip-name', text: `chance that peak demand goes above its ${levelWords()} level` }),
      hit != null ? h('div', { class: 'tip-obs', text: hit ? 'It happened: observed peak reached that level.' : 'It did not happen: observed peak stayed below.' }) : null,
      spark,
      h('div', { class: 'tip-name', text: 'Chance over the next 14 days, 0 to 100%; dot is the chosen date' }),
      n.flag ? h('div', { class: 'tip-flag', text: 'No live EIA demand feed, so this is not reliable.' }) : null].filter(Boolean));
    tip.hidden = false;
    const wr = wrap.getBoundingClientRect(), ar = n.dot.getBoundingClientRect();
    const cx = ar.left + ar.width / 2 - wr.left, cy = ar.top + ar.height / 2 - wr.top;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = cx + 18, y = cy - th / 2;
    if (x + tw > wr.width - 8) x = cx - tw - 18;
    if (x < 8) { x = Math.max(8, Math.min(wr.width - tw - 8, cx - tw / 2)); y = cy + 24 + th > wr.height ? cy - th - 24 : cy + 24; }
    y = Math.max(8, Math.min(y, wr.height - th - 8));
    tip.style.setProperty('left', x + 'px');
    tip.style.setProperty('top', y + 'px');
  }
  function hideTip() {
    const had = st.hoverBa;
    st.tipNode = null; st.hoverBa = null;
    const tip = FC.$('#tip'); if (tip) tip.hidden = true;
    FC.$$('#map a.is-hover').forEach((x) => x.classList.remove('is-hover'));
    if (st.map && st.map.hl) st.map.hl.setAttribute('d', '');
    if (had && st.map) placeLabels();
  }

  /* ---------- per-BA rows: demand values for every date, plus outcomes on a hindcast ---------- */
  async function loadDetails() {
    try {
      const docs = await Promise.all(bas().map((b) => FC.getJSON(st.issue + '/' + b.ba + '.json').catch(() => null)));
      const det = {};
      docs.forEach((d) => {
        if (!d || !d.targets || !d.targets.peak || typeof d.ba !== 'string') return;
        const rows = {};
        ['d', 'w'].forEach((kind) => (d.targets.peak[kind] || []).forEach((r) => { rows[FC.leadKey(r.lead, kind)] = r; }));
        det[d.ba] = rows;
      });
      st.det = det;
      if (st.summary.kind === 'replay') {
        st.obs = det;
        FC.$('#hitKey') || FC.$('.map-legend').appendChild(h('span', { class: 'legend-hit', id: 'hitKey' }, h('i', { 'aria-hidden': 'true' }), st.geo ? 'White dot: it happened' : 'White centre: it happened'));
      }
    } catch (e) { st.det = st.det || {}; /* values and outcomes are a bonus; the forecast still shows */ }
    update();
  }
  function obsHit(ba, i) {
    if (!st.obs || !st.obs[ba]) return null;
    const r = st.obs[ba][leadAt(i)];
    if (!r || r.observed == null || !r.t || r.t[st.th] == null) return null;
    return r.observed > r.t[st.th];
  }
  function obsCount(i) {
    if (!st.obs) return null;
    let n = 0, of = 0;
    reliable().forEach((b) => { const v = obsHit(b.ba, i); if (v != null) { of++; if (v) n++; } });
    return of ? { n, of } : null;
  }

  /* ---------- date scrubber ---------- */
  function buildScrubber() {
    const el = FC.$('#scrub'), ls = leads();
    const days = [], weeks = [];
    ls.forEach((k, i) => (FC.isWeek(k) ? weeks : days).push(i));
    const today = new Date(); const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    el.style.setProperty('--n', days.length);
    const tiles = days.map((i, j) => {
      const d = dates(i).a, prev = j ? dates(days[j - 1]).a : null;
      const newMonth = !prev || FC.monShort(prev) !== FC.monShort(d);
      return h('div', { class: 'tile' + (FC.isWeekend(d) ? ' we' : ''), 'data-i': i },
        h('span', { class: 't-dow', text: FC.dowShort(d) }),
        h('span', { class: 't-day', text: String(FC.dayNum(d)) }),
        h('span', { class: 't-mon', text: newMonth ? FC.monShort(d) : '' }),
        h('span', { class: 't-bar' }, h('i')),
        h('span', { class: 't-obs' }),
        d === todayISO ? h('span', { class: 't-tag', text: 'Today' }) : null,
        h('span', { class: 't-top', text: 'Highest risk' }));
    });
    // a week band spans the day tiles it covers
    const bands = weeks.map((i) => {
      const d = dates(i);
      const c0 = days.findIndex((j) => dates(j).a === d.a), c1 = days.findIndex((j) => dates(j).a === d.b);
      const band = h('div', { class: 'band', 'data-i': i },
        h('b', { text: 'Week ' + leadAt(i).slice(1) }), h('span', { text: FC.fmtRange(d.a, d.b) }), h('span', { class: 'band-bar' }, h('i')));
      if (c0 >= 0) band.style.setProperty('grid-column', `${c0 + 1} / ${(c1 >= 0 ? c1 : days.length - 1) + 2}`);
      return band;
    });
    st.nat = FC.s('svg', { class: 'nat', 'aria-hidden': 'true' });
    el.replaceChildren(h('div', { class: 'nat-wrap' }, h('span', { class: 'nat-lbl', text: 'Highest chance anywhere' }), st.nat), h('div', { class: 'tiles' }, tiles), bands.length ? h('div', { class: 'bands' }, bands) : null);
    el.setAttribute('aria-valuemax', String(ls.length - 1));
    st.scrub = { days, weeks };

    // pointer: click or drag across tiles/bands; touch drags horizontally, page still scrolls vertically
    let dragging = false;
    const pick = (e) => {
      const t = document.elementFromPoint(e.clientX, e.clientY);
      const cell = t && t.closest('#scrub [data-i]');
      if (cell) { setLead(+cell.getAttribute('data-i')); return; }
      const tr = el.querySelector('.tiles').getBoundingClientRect();
      if (e.clientY >= tr.top && e.clientY <= tr.bottom) {
        const j = Math.floor(((e.clientX - tr.left) / tr.width) * days.length);
        setLead(days[Math.max(0, Math.min(days.length - 1, j))]);
      }
    };
    el.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; dragging = true; stopPlay(); el.setPointerCapture(e.pointerId); pick(e); el.classList.add('is-drag'); });
    el.addEventListener('pointermove', (e) => { if (dragging) pick(e); });
    const end = () => { dragging = false; el.classList.remove('is-drag'); };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('keydown', (e) => {
      const i = st.li, wk = isWk(i);
      let n = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') n = i + 1;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') n = i - 1;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = days[days.length - 1];
      else if (e.key === 'PageDown' && weeks.length) n = wk ? weeks[Math.min(weeks.length - 1, weeks.indexOf(i) + 1)] : weeks[0];
      else if (e.key === 'PageUp') n = wk ? days[0] : Math.max(0, i - 7);
      if (n == null) return;
      e.preventDefault(); stopPlay(); setLead(n);
    });
    FC.$('#jump').addEventListener('click', () => { stopPlay(); setLead(riskiestDay()); FC.$('#scrub').focus(); });
  }

  function riskiestDay() {
    let best = 0, bp = -1;
    st.scrub.days.forEach((i) => { const m = dayStats(i).max; if (m != null && m > bp) { bp = m; best = i; } });
    return best;
  }

  function updateScrubber() {
    if (!st.scrub) return;
    const el = FC.$('#scrub'), i = st.li, top = riskiestDay();
    FC.$$('#scrub [data-i]').forEach((c) => {
      const j = +c.getAttribute('data-i'), S = dayStats(j);
      const bar = c.querySelector('.t-bar i, .band-bar i');
      if (bar) { bar.setAttribute('class', FC.bin(S.max)); bar.style.setProperty('--h', Math.max(0.08, S.max || 0)); }
      const o = c.querySelector('.t-obs');
      if (o) { const oc = obsCount(j); o.textContent = oc ? String(oc.n) : ''; o.title = oc ? `${oc.n} areas reached the level` : ''; }
      c.classList.toggle('is-on', j === i);
      c.classList.toggle('is-top', j === top && (S.max || 0) >= 0.2);
      c.classList.toggle('in-week', isWk(i) && !isWk(j) && dates(j).a >= dates(i).a && dates(j).a <= dates(i).b);
    });
    // highest chance anywhere, per day: a simple area + line on a fixed 0-100% scale, chosen day marked
    const mx = st.scrub.days.map((j) => dayStats(j).max || 0);
    const nw = st.nat.clientWidth || 600, nh = st.nat.clientHeight || 40, n = mx.length, cw = nw / n;
    const nx = (j) => (j + 0.5) * cw, ny = (v) => nh - 2 - v * (nh - 6);
    st.nat.setAttribute('viewBox', `0 0 ${nw} ${nh}`);
    const dl = 'M' + mx.map((v, j) => nx(j).toFixed(1) + ',' + ny(v).toFixed(1)).join('L');
    const sj = st.scrub.days.indexOf(i);
    st.nat.replaceChildren(
      FC.s('line', { class: 'nat-base', x1: 0, x2: nw, y1: ny(0) + 0.5, y2: ny(0) + 0.5 }),
      FC.s('path', { class: 'nat-area', d: dl + `L${nx(n - 1).toFixed(1)},${ny(0)}L${nx(0).toFixed(1)},${ny(0)}Z` }),
      FC.s('path', { class: 'nat-line', d: dl }),
      sj >= 0 ? FC.s('line', { class: 'nat-cur', x1: nx(sj), x2: nx(sj), y1: 0, y2: nh }) : null,
      sj >= 0 ? FC.s('circle', { class: 'nat-dot', cx: nx(sj), cy: ny(mx[sj]), r: 3 }) : null);
    const S = dayStats(i), oc = obsCount(i);
    const txt = `${whenWords(i, true)}. ` + (S.top ? `Highest chance ${FC.fmtPct(S.top.p)}, ${FC.place(S.top.b.ba)}. ${S.n35} of ${S.vals.length} areas at 35% or more.` : 'No data.') + (oc ? ` Observed: ${oc.n} areas reached the level.` : '');
    el.setAttribute('aria-valuenow', String(i));
    el.setAttribute('aria-valuetext', txt);
    const tp = dayStats(top).max;
    const jb = FC.$('#jump');
    jb.hidden = !(tp >= 0.2) || top === i;
    jb.textContent = `Jump to the riskiest day, ${FC.fmtDate(dates(top).a)}`;
    el.classList.toggle('has-obs', !!st.obs);
  }

  /* ---------- time-lapse ---------- */
  function initPlay() {
    FC.$('#play').addEventListener('click', () => (st.playing ? stopPlay() : startPlay()));
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlay(); });
  }
  function startPlay() {
    const days = st.scrub.days;
    if (!days.length) return;
    if (isWk(st.li) || st.li >= days[days.length - 1]) setLead(days[0], { force: true });
    const btn = FC.$('#play');
    btn.setAttribute('aria-pressed', 'true'); FC.$('#playLabel').textContent = 'Pause';
    st.playing = setInterval(() => {
      const k = days.indexOf(st.li);
      if (k < 0 || k >= days.length - 1) return stopPlay();
      setLead(days[k + 1]);
    }, reduce.matches ? 1600 : 1100);
  }
  function stopPlay() {
    if (!st.playing) return;
    clearInterval(st.playing); st.playing = 0;
    FC.$('#play').setAttribute('aria-pressed', 'false'); FC.$('#playLabel').textContent = 'Play the two weeks';
  }

  /* ---------- day-by-day table ---------- */
  function renderTable() {
    const ls = leads(), cells = cellsFor();
    const maxOf = (ba) => { let m = null; (cells[ba] || []).forEach((v) => { if (v != null && (m == null || v > m)) m = v; }); return m; };
    const rows = bas().map((b) => ({ b, flag: flagOf(b.ba), vals: ls.map((k, i) => (cells[b.ba] || [])[i] ?? null), max: maxOf(b.ba), v: valOf(b.ba, st.li) }));
    const { col, dir } = st.sort;
    const key = (r) => (col === 'max' ? r.max : col === 'mw' ? r.v && r.v.med : col === 'rel' ? r.v && r.v.rel : r.vals[ls.indexOf(col)]);
    rows.sort((x, y) => {
      if (!!x.flag !== !!y.flag) return x.flag ? 1 : -1;
      if (col === 'ba') return dir * FC.place(x.b.ba).replace(/^the /, '').localeCompare(FC.place(y.b.ba).replace(/^the /, ''));
      const vx = key(x), vy = key(y);
      return dir * ((vx ?? -1) - (vy ?? -1)) || x.b.ba.localeCompare(y.b.ba);
    });
    const sortBtn = (key, top, sub, label) => {
      const active = col === key;
      return h('button', { type: 'button', class: 'sort', 'data-key': key, 'aria-label': label, onclick: () => {
        st.sort = active ? { col: key, dir: -dir } : { col: key, dir: key === 'ba' ? 1 : -1 };
        renderTable(); const again = FC.$(`#riskScroll button[data-key="${key}"]`); if (again) again.focus();
      } }, h('b', { text: top }), sub ? h('small', { text: sub }) : null, h('i', { 'aria-hidden': 'true', text: active ? (dir > 0 ? '▲' : '▼') : '' }));
    };
    const ariaSort = (key) => (col === key ? (dir > 0 ? 'ascending' : 'descending') : null);
    const wkFirst = (i) => FC.isWeek(ls[i]) && i > 0 && !FC.isWeek(ls[i - 1]);
    const head = h('tr', null,
      h('th', { scope: 'col', 'aria-sort': ariaSort('ba') }, sortBtn('ba', 'Area', 'sort A–Z', 'Area, sort alphabetically')),
      h('th', { scope: 'col', class: 'sp-h' }, h('span', { text: 'Next 14 days · chosen date' })),
      h('th', { scope: 'col', class: 'val-h', 'aria-sort': ariaSort('mw') }, sortBtn('mw', 'Peak MW', whenShort(st.li), `Expected peak demand in megawatts, ${whenWords(st.li)}, sort`)),
      h('th', { scope: 'col', class: 'val-h', 'aria-sort': ariaSort('rel') }, sortBtn('rel', 'vs level', levelWords(), `Expected peak as a share of the ${levelWords()} level, ${whenWords(st.li)}, sort`)),
      ls.map((k, i) => {
        const d = dates(i);
        const top = FC.isWeek(k) ? 'Week ' + k.slice(1) : FC.dowShort(d.a) + ' ' + FC.dayNum(d.a);
        const sub = FC.isWeek(k) ? FC.fmtRange(d.a, d.b) : k;
        return h('th', { scope: 'col', class: [i === st.li ? 'is-lead' : '', wkFirst(i) ? 'wk-first' : ''].join(' ').trim() || null, 'aria-sort': ariaSort(k) },
          sortBtn(k, top, sub, `${whenWords(i, true)}, sort by chance`));
      }),
      h('th', { scope: 'col', class: 'max', 'aria-sort': ariaSort('max') }, sortBtn('max', 'Highest', 'any day', 'Highest chance on any day, sort')));
    const body = rows.map((r) => h('tr', { class: r.flag ? 'is-flag' : null },
      h('th', { scope: 'row' }, h('a', { href: FC.baHref(r.b.ba, st.issue) },
        h('b', { text: FC.cap(FC.place(r.b.ba)) }),
        h('small', { text: r.flag ? r.b.ba + ', no live demand feed, not reliable' : r.b.ba + ', ' + ((FC.PLACES[r.b.ba] || [])[1] || r.b.name || '') }))),
      h('td', { class: 'sp' }, h('span', { class: 'sp-in' }, FC.spark(r.vals.filter((v, i) => !FC.isWeek(ls[i])), isWk(st.li) ? -1 : st.li, !!r.flag),
        h('span', { class: 'sp-v', text: r.flag ? '–' : FC.fmtPct(r.vals[st.li]) }))),
      h('td', { class: 'val' }, r.flag ? '–' : r.v && r.v.med != null ? FC.fmtNum(r.v.med) : (st.det ? '–' : '…')),
      h('td', { class: 'val' }, r.flag ? '–' : r.v && r.v.rel != null ? fmtRel(r.v.rel) : (st.det ? '–' : '…')),
      r.vals.map((v, i) => h('td', { class: [r.flag ? 'bna' : FC.bin(v), i === st.li ? 'is-lead' : '', wkFirst(i) ? 'wk-first' : ''].join(' ').trim() }, r.flag ? '–' : FC.fmtPct(v))),
      h('td', { class: 'max ' + (r.flag ? 'bna' : FC.bin(r.max)) }, r.flag ? '–' : FC.fmtPct(r.max))));
    const tbl = h('table', { class: 'heat' + (st.tableDrawn ? '' : ' grow') },
      h('caption', { class: 'sr-only', text: `Chance that peak demand lands in each area's ${levelWords()} for the time of year. Rows are areas, columns are dates. Forecast issued ${FC.fmtWords(st.issue, true)}${st.summary.kind === 'replay' ? ', hindcast' : ''}. Column buttons sort the table.` }),
      h('thead', null, head), h('tbody', null, body));
    const sc = FC.$('#riskScroll'), keep = sc.scrollLeft;
    sc.replaceChildren(tbl); sc.scrollLeft = keep; st.tableDrawn = true;
    FC.$('#riskSub').textContent = `The chance that each area's ${st.summary.kind === 'replay' ? 'peak demand would land' : 'peak demand lands'} in its ${levelWords()} for the time of year. For the two weeks at the right, it is the week's highest daily peak. The outlined column is the date chosen above; Peak MW is the middle (median) forecast of peak demand on that date, and "vs level" compares it with the area's ${levelWords()} level.`;
  }
})();
