/* Area page: plain-language summary, daily forecast chart (7 or 14 days), weekly ranges, number table,
   notes, downloads. */
(function () {
  'use strict';
  const FC = window.FC, h = FC.h;
  const REF = { '90': 'Top 10% level', '95': 'Top 5% level', '99': 'Top 1% level' };
  const st = {
    issue: null, ba: null, doc: null, summary: null, info: null,
    target: FC.params.get('target') === 'energy' ? 'energy' : 'peak',
    ref: ['90', '95', '99'].includes(FC.params.get('th')) ? FC.params.get('th') : '90',
    range: 14, cursor: 0, drawn: false,
  };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    const ba = FC.safeId(FC.params.get('ba')).toUpperCase();
    let L;
    try { L = await FC.loadIssues(); } catch (e) { return FC.errorBox(FC.$('#notes'), e); }
    st.issue = FC.safeIssue(L.cur.issue);
    if (!st.issue) return FC.errorBox(FC.$('#notes'), new Error('issues.json lists an issue with an invalid date.'));
    FC.$('#backLink').setAttribute('href', 'index.html?issue=' + encodeURIComponent(st.issue));
    FC.issueMenu(FC.$('#issueMenu'), L.issues, L.cur, (iss) => FC.baHref(ba, iss));
    try { st.summary = await FC.getJSON(st.issue + '/summary.json'); } catch (e) { return FC.errorBox(FC.$('#notes'), e); }
    FC.checkStale(st.summary, L);

    const list = (st.summary.bas || []).filter((b) => FC.safeId(b.ba) === b.ba).sort((a, b) => FC.place(a.ba).replace(/^the /, '').localeCompare(FC.place(b.ba).replace(/^the /, '')));
    const baSel = FC.$('#baSel');
    baSel.replaceChildren(...list.map((b) => h('option', { value: b.ba, selected: b.ba === ba, text: `${FC.cap(FC.place(b.ba))} (${b.ba})` })));
    baSel.addEventListener('change', () => { location.href = FC.baHref(baSel.value, st.issue) + (st.target === 'energy' ? '&target=energy' : ''); });

    if (!ba || !list.some((b) => b.ba === ba)) {
      FC.$('#baTitle').textContent = 'Choose an area';
      FC.errorBox(FC.$('#notes'), new Error(ba ? `There is no area "${ba}" in this forecast. Pick one from the list.` : 'No area chosen. Pick one from the list.'));
      if (!ba) baSel.prepend(h('option', { value: '', selected: true, disabled: true, text: 'Choose…' }));
      return;
    }
    st.ba = ba;
    st.info = list.find((b) => b.ba === ba);
    try { st.doc = await FC.getJSON(st.issue + '/' + ba + '.json'); } catch (e) { return FC.errorBox(FC.$('#notes'), e); }

    FC.$('#baTitle').textContent = FC.cap(FC.place(ba));
    FC.$('#baSub').textContent = `${ba}, ${st.doc.name || st.info.name || ''}`;
    document.title = `${FC.cap(FC.place(ba))} (${ba}) · ${FC.fmtLong(st.issue)}${st.summary.kind === 'replay' ? ' hindcast' : ''} · AirCast-Energy · AIR Lab`;
    FC.$('#badges').replaceChildren(...FC.issueBadges(st.summary, L.cur));
    const notes = FC.issueNotes(st.summary);
    const flag = FC.flagOf(st.summary, ba);
    st.noProb = !!flag;
    if (flag || FC.NO_FEED[ba]) {
      notes.unshift(h('div', { class: 'note note-warn', role: 'note' }, FC.icon('alert'),
        h('div', null, h('strong', { text: 'No live EIA demand feed. ' }), FC.NO_FEED[ba] || String(flag))));
    }
    const SCALED = { NEVP: '0.66', BANC: '0.63', FPC: '0.74' };
    if (SCALED[ba] && st.summary.kind !== 'replay') {
      notes.push(h('div', { class: 'note', role: 'note' }, FC.icon('info'),
        h('div', null, h('strong', { text: 'Megawatts are on a FERC Form 714 basis. ' }), `Live EIA-930 demand for this area is scaled by about ${SCALED[ba]} to match the record the model was trained on, so megawatts here sit below the EIA-930 figures. Percentages are not affected.`)));
    }
    FC.$('#notes').replaceChildren(...notes);
    FC.$('#howObs').hidden = st.summary.kind !== 'replay';

    FC.$$('input[name="target"]').forEach((i) => {
      i.checked = i.value === st.target;
      i.addEventListener('change', () => { st.target = i.value; syncURL(); render(); });
    });
    const hs = decodeURIComponent(location.hash.slice(1));
    const di = rowsFor('d').findIndex((r) => r.date === hs);
    if (di >= 0) st.cursor = di;
    if (st.cursor >= 7) st.range = 14;
    buildTools();
    renderFacts();
    renderDownloads();
    render();
    FC.onResize(FC.$('#fan'), render);
  }

  function syncURL() {
    const u = new URL(location.href);
    if (st.target === 'energy') u.searchParams.set('target', 'energy'); else u.searchParams.delete('target');
    if (st.ref !== '90') u.searchParams.set('th', st.ref); else u.searchParams.delete('th');
    history.replaceState(null, '', u.pathname + u.search + location.hash);
  }

  // small flat button groups above the chart: range (7D / 14D) and which reference level to draw
  function buildTools() {
    const grp = (name, legend, opts, val, on) => h('fieldset', { class: 'seg seg-sm' }, h('legend', { class: 'sr-only', text: legend }),
      h('div', { class: 'seg-row' }, opts.map((o) => h('label', null,
        h('input', { type: 'radio', name, value: o.v, checked: o.v === val, onchange: (e) => on(e.target.value) }),
        h('span', { text: o.l, title: o.t || null })))));
    FC.$('#fanTools').replaceChildren(
      grp('range', 'Days shown', [{ v: '7', l: '7D', t: 'Next 7 days' }, { v: '14', l: '14D', t: 'Next 14 days' }], String(st.range), (v) => { st.range = +v; if (st.cursor >= st.range) st.cursor = 0; render(); }),
      grp('ref', 'Reference line', [{ v: '90', l: 'Top 10%' }, { v: '95', l: 'Top 5%' }, { v: '99', l: 'Top 1%' }], st.ref, (v) => { st.ref = v; syncURL(); render(); }));
  }

  function rowsFor(kind, target) {
    target = target || st.target;
    const T = (st.doc.targets && st.doc.targets[target]) || {};
    const k = FC.scaleFor(target);
    return (T[kind] || []).map((r) => {
      const sc = (v) => (v == null ? null : v * k);
      const q = {}; for (const qq in (r.q || {})) q[qq] = sc(r.q[qq]);
      const t = {}; for (const tt in (r.t || {})) t[tt] = sc(r.t[tt]);
      return { key: FC.leadKey(r.lead, kind), raw: r, q, t, p: r.p || {}, observed: sc(r.observed), date: r.date, ws: r.week_start, we: r.week_end };
    });
  }
  // Areas with no live demand feed (flagged) show ranges only: their chances are not valid
  const hasProbs = (rows) => !st.noProb && rows.some((r) => r.p && ['90', '95', '99'].some((k) => r.p[k] != null));
  const when = (r) => (r.date ? FC.fmtWords(r.date) : 'the week of ' + FC.fmtRangeWords(r.ws, r.we));

  // One or two sentences a non-expert can act on
  function renderLede() {
    const d = rowsFor('d', 'peak'), w = rowsFor('w', 'peak');
    const all = st.noProb ? [] : d.concat(w.slice(0, 2)).filter((r) => r.p['90'] != null);
    const replay = st.summary.kind === 'replay';
    const place = FC.place(st.ba);
    let txt;
    if (!all.length) txt = `This forecast has demand ranges for ${place} but no chances of unusually high demand.`;
    else {
      const best = all.reduce((a, b) => (b.p['90'] > a.p['90'] ? b : a));
      const n50 = d.filter((r) => r.p['90'] >= 0.5).length;
      const p = best.p['90'];
      if (p >= 0.5) txt = `${replay ? 'The forecast gave' : 'There is'} a ${FC.fmtPct(p)} chance (${FC.oneIn(p)}) that peak demand in ${place} lands in its top 10% for the time of year on ${when(best)}` + (n50 > 1 ? `, and better-than-even odds on ${n50} of the next 14 days.` : '.');
      else if (p >= 0.2) txt = `Demand in ${place} looks mostly ordinary. The highest chance of an unusually high day is ${FC.fmtPct(p)} (${FC.oneIn(p)}), on ${when(best)}. On an ordinary day it is 1 in 10.`;
      else txt = `Demand in ${place} looks ordinary for the next two weeks: no day has more than a ${FC.fmtPct(p)} chance of landing in its top 10% for the time of year.`;
      if (replay) {
        const hits = d.filter((r) => r.raw.observed != null && r.raw.t && r.raw.observed > r.raw.t['90']).length;
        txt += ` What happened: ${hits} of the 14 days actually reached that level.`;
      }
    }
    if (FC.NO_FEED[st.ba]) txt += ' Treat these numbers with caution: there is no live demand feed for this area.';
    FC.$('#baLede').textContent = txt;
  }

  const fv = (v) => FC.fmtVal(v, st.target);
  const rng = (r, a, b) => `${fv(r.raw.q[a])}–${fv(r.raw.q[b])}`;
  // ticker strip items for one day or week
  function stripItems(r, unit, probs, isWeek) {
    const ref = REF[st.ref].replace(' level', '');
    return [
      { k: isWeek ? 'Week ' + r.key.slice(1) : FC.dowShort(r.date), v: isWeek ? FC.fmtRange(r.ws, r.we) : FC.fmtShort(r.date) + ', ' + FC.parseDate(r.date).getUTCFullYear(), cls: 'cx-date' },
      { k: 'Median', v: fv(r.raw.q['50']) + ' ' + unit, cls: 'cx-med' },
      { k: '50% range', v: rng(r, '25', '75') },
      { k: '90% range', v: rng(r, '05', '95') },
      r.raw.observed != null ? { k: 'Observed', v: fv(r.raw.observed), cls: 'cx-obs' } : null,
      probs && r.p && r.p[st.ref] != null ? { k: ref + ' chance', v: FC.fmtPct(r.p[st.ref]) } : null,
    ];
  }

  function render() {
    renderLede();
    const dAll = rowsFor('d'), w = rowsFor('w');
    const d = dAll.slice(0, st.range);
    const unitD = FC.unitFor(st.target, false), unitW = FC.unitFor(st.target, true);
    const probs = hasProbs(dAll.concat(w));
    const noun = st.target === 'energy' ? 'daily energy' : 'peak demand';
    FC.$('#fanTitle').textContent = (st.target === 'energy' ? 'Daily energy' : 'Daily peak demand') + `, next ${st.range} days`;
    FC.$('#fanSub').textContent = probs ? '' : (st.noProb ? 'No live demand feed for this area, so chances of high demand are not shown and the ranges are not reliable.' : 'Energy has ranges but no top-10% levels or chances in this model version.');
    FC.$('#fanSub').hidden = !!probs;
    FC.$('#fanTools').querySelector('fieldset:last-child').hidden = !probs;

    const hostF = FC.$('#fan');
    if (!d.length) hostF.replaceChildren(h('p', { class: 'loading', text: 'No daily forecast in this run.' }));
    else {
      if (st.cursor >= d.length) st.cursor = 0;
      const med = d.map((r) => r.raw.q['50']).filter((v) => v != null);
      const res = FC.fanChart(hostF, d.map((r) => ({ date: r.date, q: r.q, ref: probs ? r.t[st.ref] : null, observed: r.observed })), {
        unit: unitD, refLabel: REF[st.ref], start: st.cursor, animate: !st.drawn,
        fmt: (v) => FC.fmtVal(v / FC.scaleFor(st.target), st.target),
        aria: `${FC.cap(noun)} forecast for ${FC.place(st.ba)}, ${FC.fmtWords(d[0].date)} to ${FC.fmtWords(d[d.length - 1].date)}. The median forecast runs between ${fv(Math.min(...med))} and ${fv(Math.max(...med))} ${unitD}. Use the arrow keys for each day; the table lists every value.`,
        strip: (i) => stripItems(d[i], unitD, probs, false),
        onCursor: (i, why) => {
          if (why === 'hover' || why === 'restore') return;
          st.cursor = i; markRow(d[i].key);
          if (why === 'key') FC.$('#fanRead').replaceChildren(...readout(d[i], unitD));
        },
      });
      st.drawn = true;
      FC.$('#fanKey').replaceChildren(...legend(probs, res.hasObs, true));
      FC.$('#fanNote').textContent = `Value axis in ${unitD}, scaled to the data; it does not start at zero. Weekends are shaded.`;
    }

    const hostW = FC.$('#weeks');
    FC.$('#wkTitle').textContent = st.target === 'energy' ? 'Weekly energy (total of seven days)' : 'Weekly peak (highest day of each week)';
    const extended = w.filter((r) => /^w([3-9]|\d\d)/.test(r.key)).length;
    FC.$('#wkSub').textContent = extended ? 'Weeks 3 to 6 are faded: that far ahead, research tests show the forecast is barely better than the long-term average.' : st.summary.kind === 'live' ? 'Live runs cover the first two weeks only.' : '';
    if (!w.length) hostW.replaceChildren(h('p', { class: 'loading', text: 'No weekly forecast in this run.' }));
    else {
      FC.boxChart(hostW, w.map((r) => ({ label: 'Week ' + r.key.slice(1), sub: FC.fmtRange(r.ws, r.we), q: r.q, ref: probs ? r.t[st.ref] : null, observed: r.observed, dim: /^w([3-9]|\d\d)/.test(r.key) })), {
        unit: unitW,
        fmt: (v) => FC.fmtVal(v / FC.scaleFor(st.target), st.target),
        aria: `${FC.cap(noun)} by week for ${FC.place(st.ba)}, ${w.length} weeks. Use the arrow keys for each week; the table lists every value.`,
        strip: (i) => stripItems(w[i], unitW, probs, true),
        onCursor: (i, why) => { if (why === 'key') FC.$('#wkRead').replaceChildren(...readout(w[i], unitW)); },
      });
      FC.$('#wkKey').replaceChildren(...legend(probs, w.some((r) => r.observed != null), false));
    }
    renderTable(dAll, w, probs, unitD, unitW);
  }

  function legend(probs, obs, line) {
    const k = (cls, txt) => h('span', null, h('i', { class: cls, 'aria-hidden': 'true' }), txt);
    return [
      k(line ? 'k-med' : 'k-boxmed', 'Median forecast'),
      k('k-band50', '50% range'),
      k(line ? 'k-band90' : 'k-whisk', '90% range'),
      obs ? k(line ? 'k-obs' : 'k-obsdot', 'Observed') : null,
      probs ? k('k-ref', REF[st.ref]) : null,
    ].filter(Boolean);
  }

  function obsWhere(r) {
    const o = r.raw.observed, q = r.raw.q;
    return o < q['05'] ? 'below the 90% range' : o > q['95'] ? 'above the 90% range' : 'inside the 90% range';
  }
  function readout(r, unit) {
    const parts = [h('b', { text: FC.cap(when(r)) }), ': median forecast ', h('b', { text: fv(r.raw.q['50']) + ' ' + unit }), ', 90% range ', h('b', { text: rng(r, '05', '95') }), '.'];
    if (r.raw.observed != null) parts.push(' Observed ', h('b', { text: fv(r.raw.observed) }), ` (${obsWhere(r)}).`);
    if (!st.noProb && r.p && r.p['90'] != null) parts.push(' Chance of a top-10% day ', h('b', { text: FC.fmtPct(r.p['90']) }), ` (${FC.oneIn(r.p['90'])}); top 5% `, h('b', { text: FC.fmtPct(r.p['95']) }), '; top 1% ', h('b', { text: FC.fmtPct(r.p['99']) }), '.');
    return parts;
  }
  function markRow(key) {
    FC.$$('#tbl tr.is-cursor').forEach((x) => x.classList.remove('is-cursor'));
    const tr = FC.$(`#tbl tr[data-k="${CSS.escape(String(key))}"]`); if (tr) tr.classList.add('is-cursor');
  }

  function renderTable(d, w, probs, unitD, unitW) {
    const anyObs = d.concat(w).some((r) => r.raw.observed != null);
    const u = st.target === 'energy' ? 'GWh' : 'MW';
    const cols = [['Date', 'txt'], ['Lead', 'txt']];
    if (anyObs) cols.push([`Observed ${u}`, '']);
    cols.push([`5th pct ${u}`, ''], [`25th pct ${u}`, ''], [`Median ${u}`, ''], [`75th pct ${u}`, ''], [`95th pct ${u}`, '']);
    if (probs) cols.push([`Top 10% level ${u}`, ''], ['P(top 10%)', ''], ['P(top 5%)', ''], ['P(top 1%)', '']);
    const row = (r, isW) => h('tr', { 'data-k': r.key, class: isW && r.key === 'w1' ? 'grp-first' : null },
      h('th', { scope: 'row', class: 'txt', text: isW ? 'Week ' + r.key.slice(1) + ', ' + FC.fmtRange(r.ws, r.we) : FC.fmtDate(r.date) }),
      h('td', { class: 'txt code', text: r.key }),
      anyObs ? h('td', { class: 'obs-cell', text: fv(r.raw.observed) }) : null,
      ['05', '25', '50', '75', '95'].map((q) => h('td', { class: q === '50' ? 'med-cell' : null, text: fv(r.raw.q[q]) })),
      probs ? [h('td', { text: fv(r.raw.t && r.raw.t['90']) }),
        ['90', '95', '99'].map((k) => h('td', { class: 'pc' }, h('span', { class: 'pcell ' + FC.bin(r.p[k]), text: FC.fmtPct(r.p[k]) })))] : null);
    const tbl = h('table', { class: 'data' },
      h('caption', { class: 'sr-only', text: `${FC.place(st.ba)} ${st.target === 'energy' ? 'daily energy' : 'peak demand'} forecast, issued ${FC.fmtWords(st.issue, true)}. Daily rows in ${unitD}, weekly rows in ${unitW}.` }),
      h('thead', null, h('tr', null, cols.map(([c, cls]) => h('th', { scope: 'col', class: cls || null, text: c })))),
      h('tbody', null, d.map((r) => row(r, false)), w.map((r) => row(r, true))));
    FC.$('#tbl').replaceChildren(tbl);
    FC.$('#tblSub').textContent = `Days in ${unitD}, weeks in ${unitW}. "5th pct" means 5% of outcomes fall below it. P(top 10%) is the chance of exceeding the top-10% level. ` + (probs ? '' : 'Energy has no chances of exceeding a level in this model version. ') + 'The CSV download has all 19 percentiles.';
    if (d[st.cursor]) markRow(d[st.cursor].key);
  }

  function renderFacts() {
    const b = st.info, rows = [];
    const add = (k, v) => { if (v != null && v !== '') rows.push(h('div', null, h('dt', { text: k }), h('dd', { text: String(v) }))); };
    add('Operator', (FC.PLACES[b.ba] || [])[1] || st.doc.name || b.name);
    add('Code', b.ba);
    add('Busiest season', b.peak_class ? ({ summer: 'Summer', winter: 'Winter', dual: 'Both summer and winter' })[b.peak_class] || b.peak_class : null);
    add('Data quality', b.tier === 'A' ? 'Tier A: passes all of our data checks' : b.tier ? 'Tier ' + b.tier : null);
    add('Location', isFinite(b.lat) ? `${(+b.lat).toFixed(1)}°N, ${Math.abs(+b.lon).toFixed(1)}°W (middle of the area)` : null);
    add('Demand data', FC.NO_FEED[b.ba] ? 'No live EIA-930 feed, so recent demand is missing.' : 'EIA-930 hourly demand; training also used FERC Form 714.');
    add('Units', 'Peak in MW. Energy shown in GWh; the downloads carry MWh per day (or per week).');
    FC.$('#facts').replaceChildren(...rows);
  }

  function renderDownloads() {
    const base = FC.DATA + st.issue + '/';
    FC.$('#dl').replaceChildren(
      h('li', null, h('a', { href: base + st.ba + '.csv', download: `${st.ba}_${st.issue}.csv` }, FC.icon('download'), 'This area as CSV'), h('small', { text: 'Every percentile, level and chance, all days and weeks' })),
      h('li', null, h('a', { href: base + st.ba + '.json' }, FC.icon('download'), 'This area as JSON'), h('small', { text: 'The data behind this page' })),
      h('li', null, h('a', { href: base + 'forecast_all.csv', download: `forecast_all_${st.issue}.csv` }, FC.icon('download'), 'All 29 areas as CSV'), h('small', { text: 'Forecast issued ' + FC.fmtLong(st.issue) })));
  }
})();
