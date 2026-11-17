/* Hand-written SVG charts drawn live from the JSON, in the conventions of grid-operator load charts and
   financial time-series charts: horizontal gridlines only, value axis on the right with thousands
   separators, a padded (not zero-based) value range, a ticker strip above the plot that follows the
   pointer, a thin crosshair with one value chip on the axis, and a last-value chip on the median line.
     FC.fanChart  daily forecast: 90% and 50% ranges (one hue), median line, observed line, one reference line
     FC.boxChart  weekly ranges as boxes (50%) and whiskers (90%)
     FC.dotChart  verification coverage by lead against a reference level
     FC.spark     table sparkline: a plain line on a fixed 0-100% scale with a dot at the selected date
   Charts are drawn at the container's pixel width so 12px text stays 12px on phones. */
(function () {
  'use strict';
  const FC = window.FC, s = FC.s, h = FC.h;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const CH = 7; // average advance of a 12px tabular figure in Archivo/system sans, for label collision checks

  function niceTicks(lo, hi, n) {
    if (!(hi > lo)) hi = lo + 1;
    const step0 = (hi - lo) / Math.max(1, n), mag = Math.pow(10, Math.floor(Math.log10(step0))), err = step0 / mag;
    const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
    const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
    return { ticks: out, step };
  }
  FC.niceTicks = niceTicks;
  const lin = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
  // axis numbers: full value with thousands separators (130,000), decimals only when the step needs them
  const fmtAxis = (v, step) => new Intl.NumberFormat('en-US', { maximumFractionDigits: step < 1 ? 1 : 0, minimumFractionDigits: step < 1 ? 1 : 0 }).format(v);
  const textW = (t) => String(t).length * CH;

  // y scale padded to the data (never forced to zero) with ticks inside the padded range only
  function yScale(vals, top, bottom, nTicks) {
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    const pad = (hi - lo) * 0.07 || Math.abs(hi) * 0.05 || 1;
    const d0 = lo - pad, d1 = hi + pad;
    const { ticks, step } = niceTicks(d0, d1, nTicks);
    return { ys: lin(d0, d1, bottom, top), ticks: ticks.filter((v) => v >= d0 && v <= d1), step, d0, d1 };
  }

  /* keyboard + pointer cursor. Pointer movement previews a point; a click or a key commits it;
     leaving the chart returns to the committed point. onMove(i, why) redraws. */
  function bindCursor(host, n, onMove, start, xToIndex) {
    let sel = Math.min(n - 1, Math.max(0, start || 0)), cur = sel;
    const go = (i, why) => { cur = i; onMove(i, why); };
    host.onkeydown = (e) => {
      let nxt = sel;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') nxt = Math.min(n - 1, sel + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') nxt = Math.max(0, sel - 1);
      else if (e.key === 'Home') nxt = 0;
      else if (e.key === 'End') nxt = n - 1;
      else return;
      e.preventDefault();
      sel = nxt; go(sel, 'key');
    };
    const at = (e) => { const svg = host.querySelector('svg'); if (!svg) return null; return xToIndex(e.clientX - svg.getBoundingClientRect().left); };
    host.onpointermove = (e) => { const i = at(e); if (i != null && i !== cur) go(i, 'hover'); };
    host.onpointerdown = (e) => { const i = at(e); if (i != null) { sel = i; go(i, 'select'); } };
    host.onpointerleave = () => { if (cur !== sel) go(sel, 'restore'); };
    return { get: () => sel, set: (i) => { sel = i; go(i, 'set'); } };
  }

  // the ticker strip above a plot: [{k: label, v: value, cls}] items, re-filled on every cursor move
  function strip(host) {
    let el = host.querySelector(':scope > .cx-strip');
    if (!el) { el = h('div', { class: 'cx-strip', 'aria-hidden': 'true' }); host.prepend(el); }
    return (items) => el.replaceChildren(...items.filter(Boolean).map((it) => h('div', { class: 'cx-item' + (it.cls ? ' ' + it.cls : '') },
      h('span', { class: 'cx-k', text: it.k }), h('span', { class: 'cx-v', text: it.v }))));
  }

  // a value chip on the right axis (rect + text); returns null when value is missing
  function chip(cls, x, y, txt, W) {
    const w = textW(txt) + 10, hgt = 18;
    const x0 = Math.min(x, W - w);
    return s('g', { class: 'chip ' + cls },
      s('rect', { x: x0, y: y - hgt / 2, width: w, height: hgt, rx: 2 }),
      s('text', { x: x0 + 5, y: y + 4 }, txt));
  }

  // x-axis: baseline, one minor tick per point, date labels every k points (never colliding), optional
  // weekday-letter row. labels: [{main, sub}] ; returns the svg group
  function xAxis(xs, n, step, base, W, labels, opt) {
    const g = [s('line', { class: 'x-base', x1: opt.x0, x2: opt.x1, y1: base + 0.5, y2: base + 0.5 })];
    for (let i = 0; i < n; i++) g.push(s('line', { class: 'x-tick', x1: xs(i), x2: xs(i), y1: base, y2: base + 4 }));
    const widest = Math.max(...labels.map((l) => textW(l.main)));
    const every = Math.max(1, Math.ceil((widest + 10) / step));
    let lastRight = -Infinity;
    const rowMain = opt.letters ? base + 33 : base + 17, rowLetter = base + 16;
    labels.forEach((l, i) => {
      if (opt.letters && l.letter) g.push(s('text', { class: 'x-letter' + (l.we ? ' is-we' : ''), x: xs(i), y: rowLetter, 'text-anchor': 'middle' }, l.letter));
      if (i % every) return;
      const w = textW(l.main);
      let x = xs(i), a = 'middle';
      if (x - w / 2 < 0) { x = Math.max(0, x - 4); a = 'start'; }
      if (x + w / 2 > W) { x = W; a = 'end'; }
      const left = a === 'start' ? x : a === 'end' ? x - w : x - w / 2;
      if (left < lastRight + 6) return;
      lastRight = left + w;
      g.push(s('text', { class: 'x-lbl', x, y: rowMain, 'text-anchor': a }, l.main));
    });
    return g;
  }

  // right-hand y axis: horizontal gridlines across the plot, labels right of it, unit as the axis title
  function yAxis(Y, x0, x1, W, top, unit) {
    return [
      ...Y.ticks.map((v) => s('g', null,
        s('line', { class: 'grid', x1: x0, x2: x1, y1: Math.round(Y.ys(v)) + 0.5, y2: Math.round(Y.ys(v)) + 0.5 }),
        s('text', { class: 'y-lbl', x: x1 + 8, y: Y.ys(v) + 4 }, fmtAxis(v, Y.step)))),
      s('text', { class: 'y-unit', x: W, y: top - 18, 'text-anchor': 'end' }, unit || ''),
    ];
  }

  const toPath = (pts) => (pts.length ? 'M' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L') : '');
  function setD(el, d, morph) {
    el.setAttribute('d', d || 'M0,0');
    if (morph && !reduce.matches && CSS.supports('d', 'path("M0 0")')) el.style.setProperty('d', `path("${d || 'M0,0'}")`);
    else el.style.removeProperty('d');
  }

  /* ---------- daily forecast chart ----------
     rows: [{date, q:{'05'..'95'}, ref, observed}] in display units
     opt: {unit, refLabel, start, animate, aria, strip(i) -> items, onCursor(i, why)} */
  FC.fanChart = function (host, rows, opt) {
    const W = Math.max(280, host.clientWidth), narrow = W < 560;
    const H = narrow ? 272 : 332;
    const m = { l: 0, r: narrow ? 58 : 66, t: 32, b: 48 };
    const n = rows.length, pw = W - m.l - m.r, step = pw / n;
    const xs = (i) => m.l + (i + 0.5) * step;
    const vals = [];
    rows.forEach((r) => { ['05', '95'].forEach((k) => r.q[k] != null && vals.push(r.q[k])); if (r.observed != null) vals.push(r.observed); if (r.ref != null) vals.push(r.ref); });
    const Y = yScale(vals, m.t, H - m.b, narrow ? 4 : 5), ys = Y.ys;
    const band = (a, b) => { const top = rows.map((r, i) => [xs(i), ys(r.q[b])]), bot = rows.map((r, i) => [xs(i), ys(r.q[a])]).reverse(); return toPath(top.concat(bot)) + 'Z'; };
    const line = (get) => { let d = '', pen = false; rows.forEach((r, i) => { const v = get(r); if (v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + xs(i).toFixed(1) + ',' + ys(v).toFixed(1); pen = true; }); return d; };

    // keep the skeleton between redraws of the same size so the paths can morph
    let K = host._fan;
    const reuse = K && K.W === W && K.n === n && host.contains(K.svg);
    if (!reuse) {
      K = { W, n };
      K.svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
      K.bg = s('g', { 'aria-hidden': 'true' }); K.axes = s('g', { class: 'ax', 'aria-hidden': 'true' });
      K.band90 = s('path', { class: 'band90' }); K.band50 = s('path', { class: 'band50' });
      K.ref = s('g', { class: 'ref-g' }); K.med = s('path', { class: 'med', pathLength: 1 });
      K.obsLine = s('path', { class: 'obs-line', pathLength: 1 }); K.obsEnd = s('g', { class: 'obs-end' });
      K.chips = s('g', { 'aria-hidden': 'true' }); K.cursor = s('g', { 'aria-hidden': 'true' });
      K.svg.append(K.bg, K.band90, K.band50, K.axes, K.ref, K.med, K.obsLine, K.obsEnd, K.cursor, K.chips);
      host.replaceChildren(K.svg);
      K.strip = strip(host);
      host._fan = K;
    }
    K.svg.setAttribute('aria-label', opt.aria || '');
    K.svg.setAttribute('role', 'img');
    K.svg.classList.toggle('enter', !!opt.animate && !reuse);

    // weekends lightly shaded, full plot height
    K.bg.replaceChildren(...rows.map((r, i) => (FC.isWeekend(r.date) ? s('rect', { class: 'wkend', x: xs(i) - step / 2, y: m.t, width: step, height: H - m.b - m.t }) : null)).filter(Boolean));
    const labels = rows.map((r) => ({ main: FC.fmtShort(r.date), letter: FC.dowShort(r.date).charAt(0), we: FC.isWeekend(r.date) }));
    K.axes.replaceChildren(...yAxis(Y, m.l, W - m.r, W, m.t, opt.unit), ...xAxis(xs, n, step, H - m.b, W - m.r, labels, { x0: m.l, x1: W - m.r, letters: step >= 11 }));

    setD(K.band90, band('05', '95'), reuse);
    setD(K.band50, band('25', '75'), reuse);
    setD(K.med, line((r) => r.q['50']), reuse);

    // one reference line (the chosen top-x% level), labelled once at its left end above the line
    // collision test for a text box [x0,x1]x[y0,y1] against the median and observed lines (sampled)
    const lineAt = (get, x) => { const f = (x - m.l) / step - 0.5, i = Math.max(0, Math.min(n - 1, Math.floor(f))), j = Math.min(n - 1, i + 1); const a = get(rows[i]), b = get(rows[j]); if (a == null || b == null) return null; const t = Math.max(0, Math.min(1, f - i)); return ys(a + (b - a) * t); };
    const clear = (x0, x1, y0, y1, taken) => {
      if (x0 < m.l || x1 > W - m.r - 2 || y0 < m.t || y1 > H - m.b - 2) return false;
      for (let x = x0; x <= x1; x += 4) for (const get of [(r) => r.q['50'], (r) => r.observed]) { const y = lineAt(get, x); if (y != null && y > y0 - 3 && y < y1 + 3) return false; }
      return !(taken || []).some((b) => x0 < b[1] && x1 > b[0] && y0 < b[3] && y1 > b[2]);
    };
    const taken = [];
    // one reference line (the chosen top-x% level), labelled once just above or below it where no line crosses
    const hasRef = rows.some((r) => r.ref != null);
    if (hasRef) {
      const lbl = opt.refLabel || 'Top 10% level', w = textW(lbl) + 4;
      let spot = null;
      for (let i = 0; i < n && !spot; i++) {
        const x0 = xs(i) - step / 2 + 4, ry = lineAt((r) => r.ref, x0);
        if (ry == null) continue;
        const ryEnd = lineAt((r) => r.ref, x0 + w); if (ryEnd == null) continue;
        const hi = Math.min(ry, ryEnd), lo = Math.max(ry, ryEnd);
        if (clear(x0, x0 + w, hi - 17, hi - 4)) spot = [x0, hi - 7];
        else if (clear(x0, x0 + w, lo + 4, lo + 17)) spot = [x0, lo + 14];
      }
      // no clear spot (narrow screens): the legend names the line instead of an overlapping label
      if (spot) taken.push([spot[0], spot[0] + w, spot[1] - 12, spot[1] + 3]);
      K.ref.replaceChildren(s('path', { class: 'ref', d: line((r) => r.ref) }), spot ? s('text', { class: 'ref-lbl', x: spot[0], y: spot[1] }, lbl) : '');
    } else K.ref.replaceChildren();

    const hasObs = rows.some((r) => r.observed != null);
    setD(K.obsLine, hasObs ? line((r) => r.observed) : '', reuse);
    K.obsLine.style.setProperty('visibility', hasObs ? 'visible' : 'hidden');
    let lastObs = -1; rows.forEach((r, i) => { if (r.observed != null) lastObs = i; });
    K.obsEnd.replaceChildren(lastObs >= 0 ? s('circle', { class: 'obs-dot', cx: xs(lastObs), cy: ys(rows[lastObs].observed), r: 3 }) : '');

    const lastMed = rows[n - 1].q['50'];
    // direct labels at the line ends, with a halo so they stay legible over the bands; nudged apart
    // try spots near each line's end (above, below, then further left) and keep the first clear one
    const dl = [];
    const place = (t, i, y, cls) => {
      const w = textW(t);
      for (let back = 0; back <= Math.min(4, i); back++) {
        const xr = xs(i - back) - 6, ly = back ? lineAt(cls === 'dlbl dlbl-med' ? (r) => r.q['50'] : (r) => r.observed, xr - w / 2) : y;
        if (ly == null) continue;
        for (const yy of [ly - 8, ly + 17]) if (clear(xr - w, xr, yy - 12, yy + 3, taken)) { taken.push([xr - w, xr, yy - 12, yy + 3]); dl.push({ x: xr, y: yy, t, cls }); return; }
      }
    };
    if (lastMed != null) place('Median', n - 1, ys(lastMed), 'dlbl dlbl-med');
    if (lastObs >= 0) place('Observed', lastObs, ys(rows[lastObs].observed), 'dlbl dlbl-obs');
    K.labels = K.labels || K.svg.insertBefore(s('g', { 'aria-hidden': 'true' }), K.cursor);
    K.labels.replaceChildren(...dl.map((l) => s('text', { class: l.cls, x: l.x, y: l.y, 'text-anchor': 'end' }, l.t)));
    const fmt = opt.fmt || FC.fmtNum;
    const xToIndex = (px) => Math.max(0, Math.min(n - 1, Math.floor((px - m.l) / step)));
    function draw(i, why) {
      const r = rows[i], med = r.q['50'];
      const crossChip = med != null ? chip('chip-cross', W - m.r + 2, ys(med), fmt(med), W) : null;
      const showLast = lastMed != null && !(med != null && Math.abs(ys(med) - ys(lastMed)) < 19);
      K.chips.replaceChildren(showLast ? chip('chip-last', W - m.r + 2, ys(lastMed), fmt(lastMed), W) : '', crossChip || '');
      K.cursor.replaceChildren(
        s('line', { class: 'cross', x1: Math.round(xs(i)) + 0.5, x2: Math.round(xs(i)) + 0.5, y1: m.t, y2: H - m.b }),
        med != null ? s('circle', { class: 'cdot', cx: xs(i), cy: ys(med), r: 3.5 }) : '',
        r.observed != null ? s('circle', { class: 'cdot-obs', cx: xs(i), cy: ys(r.observed), r: 3 }) : '');
      if (opt.strip) K.strip(opt.strip(i));
      opt.onCursor && opt.onCursor(i, why);
    }
    const ctl = bindCursor(host, n, draw, opt.start || 0, xToIndex);
    draw(ctl.get(), 'init');
    return { hasObs, set: (i) => ctl.set(i) };
  };

  /* ---------- weekly ranges: box = 50% range, whisker = 90% range, bar = median ---------- */
  FC.boxChart = function (host, rows, opt) {
    const W = Math.max(280, host.clientWidth), narrow = W < 560;
    const H = narrow ? 236 : 276;
    const m = { l: 0, r: narrow ? 58 : 66, t: 32, b: 44 };
    const n = rows.length, bw = (W - m.l - m.r) / n, xc = (i) => m.l + bw * (i + 0.5);
    const vals = [];
    rows.forEach((r) => { ['05', '95'].forEach((k) => r.q[k] != null && vals.push(r.q[k])); if (r.observed != null) vals.push(r.observed); if (r.ref != null) vals.push(r.ref); });
    const Y = yScale(vals, m.t, H - m.b, 4), ys = Y.ys;
    const half = Math.min(22, bw * 0.24);
    const short = narrow && n > 3;
    const labels = rows.map((r) => ({ main: short ? 'W' + r.label.replace(/\D/g, '') : r.label }));
    const g = [s('g', { class: 'ax', 'aria-hidden': 'true' }, yAxis(Y, m.l, W - m.r, W, m.t, opt.unit),
      xAxis(xc, n, bw, H - m.b, W - m.r, labels, { x0: m.l, x1: W - m.r, letters: false }),
      !short ? rows.map((r, i) => s('text', { class: 'x-sub', x: xc(i), y: H - m.b + 34, 'text-anchor': 'middle' }, r.sub || '')) : null)];
    const hover = s('g', { 'aria-hidden': 'true' });
    g.unshift(hover);
    rows.forEach((r, i) => {
      const x = xc(i), q = r.q;
      g.push(s('g', { class: 'wk' + (r.dim ? ' dim' : '') },
        s('line', { class: 'whisk', x1: x, x2: x, y1: ys(q['05']), y2: ys(q['95']) }),
        s('rect', { class: 'box', x: x - half, width: half * 2, y: ys(q['75']), height: Math.max(1, ys(q['25']) - ys(q['75'])) }),
        s('line', { class: 'box-med', x1: x - half, x2: x + half, y1: ys(q['50']), y2: ys(q['50']) }),
        r.ref != null ? s('line', { class: 'ref', x1: x - half - 8, x2: x + half + 8, y1: ys(r.ref), y2: ys(r.ref) }) : null,
        r.observed != null ? s('circle', { class: 'obs-dot', cx: x, cy: ys(r.observed), r: 3.5 }) : null));
    });
    const chips = s('g', { 'aria-hidden': 'true' });
    g.push(chips);
    host.replaceChildren(s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opt.aria || '' }, g));
    const put = strip(host);
    const fmt = opt.fmt || FC.fmtNum;
    const draw = (i, why) => {
      hover.replaceChildren(s('rect', { class: 'col-hover', x: m.l + bw * i, y: m.t, width: bw, height: H - m.t - m.b }));
      const med = rows[i].q['50'];
      chips.replaceChildren(med != null ? chip('chip-cross', W - m.r + 2, ys(med), fmt(med), W) : '');
      if (opt.strip) put(opt.strip(i));
      opt.onCursor && opt.onCursor(i, why);
    };
    const ctl = bindCursor(host, n, draw, 0, (px) => Math.max(0, Math.min(n - 1, Math.floor((px - m.l) / bw))));
    draw(ctl.get(), 'init');
  };

  /* ---------- share by lead against a reference level (verification coverage) ---------- */
  FC.dotChart = function (host, rows, opt) {
    const W = Math.max(280, host.clientWidth), narrow = W < 560;
    const H = narrow ? 232 : 262;
    const m = { l: 0, r: 48, t: 32, b: 44 };
    const n = rows.length, bw = (W - m.l - m.r) / n, xc = (i) => m.l + bw * (i + 0.5);
    const vs = rows.map((r) => r.v).filter((v) => v != null).concat([opt.ref]);
    // a share: keep 0-100% bounds but pad to the data like the other charts
    const lo = Math.max(0, Math.min(...vs) - 0.08), hi = Math.min(1, Math.max(...vs) + 0.05);
    const d0 = Math.floor(lo * 10) / 10, d1 = Math.ceil(hi * 10) / 10;
    const ys = lin(d0, d1, H - m.b, m.t);
    const tickStep = d1 - d0 > 0.5 ? 0.2 : 0.1;
    const ticks = []; for (let v = d0; v <= d1 + 1e-9; v += tickStep) ticks.push(+v.toFixed(2));
    const g = [s('g', { class: 'ax', 'aria-hidden': 'true' },
      ticks.map((v) => s('g', null, s('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: Math.round(ys(v)) + 0.5, y2: Math.round(ys(v)) + 0.5 }), s('text', { class: 'y-lbl', x: W - m.r + 8, y: ys(v) + 4 }, Math.round(v * 100) + '%'))),
      s('text', { class: 'y-unit', x: W, y: m.t - 18, 'text-anchor': 'end' }, opt.yLabel || ''),
      xAxis(xc, n, bw, H - m.b, W - m.r, rows.map((r) => ({ main: r.label })), { x0: m.l, x1: W - m.r, letters: false }),
      s('text', { class: 'x-sub', x: m.l, y: H - 6, 'text-anchor': 'start' }, opt.xLabel || ''))];
    const hover = s('g', { 'aria-hidden': 'true' });
    g.unshift(hover);
    const ry = ys(opt.ref);
    g.push(s('line', { class: 'ref', x1: m.l, x2: W - m.r, y1: ry, y2: ry }));
    g.push(s('text', { class: 'ref-lbl', x: m.l + 4, y: ry - 6 > m.t + 8 ? ry - 6 : ry + 15 }, opt.refLabel));
    let d = '', pen = false;
    rows.forEach((r, i) => { if (r.v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + xc(i).toFixed(1) + ',' + ys(r.v).toFixed(1); pen = true; });
    g.push(s('path', { class: 'med', d, pathLength: 1 }));
    rows.forEach((r, i) => r.v != null && g.push(s('circle', { class: 'pt', cx: xc(i), cy: ys(r.v), r: 2.5 })));
    const cursor = s('g', { 'aria-hidden': 'true' });
    g.push(cursor);
    host.replaceChildren(s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opt.aria || '', class: 'enter' }, g));
    const put = strip(host);
    const draw = (i, why) => {
      const v = rows[i].v;
      hover.replaceChildren(s('line', { class: 'cross', x1: Math.round(xc(i)) + 0.5, x2: Math.round(xc(i)) + 0.5, y1: m.t, y2: H - m.b }));
      cursor.replaceChildren(v != null ? s('circle', { class: 'cdot', cx: xc(i), cy: ys(v), r: 3.5 }) : '', v != null ? chip('chip-cross', W - m.r + 2, ys(v), FC.fmtPct(v), W) : '');
      if (opt.strip) put(opt.strip(i));
      opt.onCursor && opt.onCursor(i, why);
    };
    const ctl = bindCursor(host, n, draw, 0, (px) => Math.max(0, Math.min(n - 1, Math.floor((px - m.l) / bw))));
    draw(ctl.get(), 'init');
  };

  /* ---------- sparkline: plain 1.5px line, fixed 0-100% scale for every row, dot at the selected date ---------- */
  FC.spark = function (vals, cur, flagged, size) {
    const W = (size && size.w) || 84, H = (size && size.h) || 24, n = vals.length, pad = 3;
    const x = (i) => pad + (n < 2 ? 0 : (i * (W - 2 * pad)) / (n - 1));
    const y = (v) => H - pad - v * (H - 2 * pad);
    let d = '', pen = false;
    vals.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1); pen = true; });
    const cv = cur >= 0 && cur < n ? vals[cur] : null;
    return s('svg', { class: 'spark' + (flagged ? ' is-flag' : ''), width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' },
      s('line', { class: 'spark-base', x1: pad, x2: W - pad, y1: y(0) + 0.5, y2: y(0) + 0.5 }),
      s('path', { class: 'spark-line', d }),
      cv != null ? s('circle', { class: 'spark-dot', cx: x(cur), cy: y(cv), r: 2.5 }) : null);
  };
})();
