/* Shared helpers for the AIR Lab demand-forecast pages.
   No frameworks, no innerHTML with data: every data value goes in through textContent. */
(function () {
  'use strict';
  const FC = (window.FC = {});
  const SVGNS = 'http://www.w3.org/2000/svg';

  FC.$ = (s, r) => (r || document).querySelector(s);
  FC.$$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  // h('a', {href: 'x', class: 'y'}, 'text', child) — tiny element builder
  function build(ns, tag, attrs, kids) {
    const el = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of kids.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }
  FC.h = (tag, attrs, ...kids) => build(null, tag, attrs, kids);
  FC.s = (tag, attrs, ...kids) => build(SVGNS, tag, attrs, kids);

  /* ---------- data ---------- */
  FC.DATA = 'data/';
  FC.params = new URLSearchParams(location.search);
  const cache = new Map();
  FC.getJSON = function (path) {
    if (cache.has(path)) return cache.get(path);
    const p = fetch(FC.DATA + path, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`Could not load ${FC.DATA + path} (HTTP ${r.status}).`);
      return r.json();
    }, () => { throw new Error(`Could not reach ${FC.DATA + path}. Serve the site over http (not file://).`); });
    cache.set(path, p);
    p.catch(() => cache.delete(path));
    return p;
  };
  FC.safeId = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '');
  FC.safeIssue = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null);

  FC.errorBox = function (where, err) {
    const box = FC.h('div', { class: 'note note-error err', role: 'alert' },
      FC.icon('alert'),
      FC.h('div', null, FC.h('strong', { text: 'Data could not be loaded. ' }), String(err && err.message ? err.message : err)));
    if (where) { where.replaceChildren(box); }
    return box;
  };

  // Load issues.json and decide which issue this page shows (?issue=, else latest)
  FC.loadIssues = async function () {
    const idx = await FC.getJSON('issues.json');
    // only well-formed issue ids ever reach a fetch path or an href
    const issues = (Array.isArray(idx.issues) ? idx.issues : []).filter((i) => i && FC.safeIssue(i.issue));
    const want = FC.safeIssue(FC.params.get('issue'));
    const cur = issues.find((i) => i.issue === want) || issues.find((i) => i.issue === idx.latest) || issues[0];
    if (!cur) throw new Error('issues.json lists no forecast issues.');
    return { idx, issues, cur };
  };

  /* ---------- leads, units, numbers ---------- */
  FC.leadKey = (x, kind) => (typeof x === 'number' || /^\d+$/.test(String(x)) ? kind + x : String(x));
  FC.isWeek = (k) => /^w/.test(k);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  FC.parseDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
  FC.fmtDate = (iso, withDow = true) => {
    const d = FC.parseDate(iso); if (!d) return '';
    return (withDow ? DOW[d.getUTCDay()] + ' ' : '') + d.getUTCDate() + ' ' + MON[d.getUTCMonth()];
  };
  const DOWL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // "Thursday 19 November" (+ year if asked)
  FC.fmtWords = (iso, year) => { const d = FC.parseDate(iso); return d ? `${DOWL[d.getUTCDay()]} ${d.getUTCDate()} ${MONL[d.getUTCMonth()]}${year ? ' ' + d.getUTCFullYear() : ''}` : ''; };
  FC.fmtRangeWords = (a, b) => {
    const da = FC.parseDate(a), db = FC.parseDate(b); if (!da || !db) return '';
    return da.getUTCMonth() === db.getUTCMonth() ? `${da.getUTCDate()}–${db.getUTCDate()} ${MONL[db.getUTCMonth()]}` : `${da.getUTCDate()} ${MONL[da.getUTCMonth()]} – ${db.getUTCDate()} ${MONL[db.getUTCMonth()]}`;
  };
  FC.isWeekend = (iso) => { const d = FC.parseDate(iso); return d ? d.getUTCDay() === 0 || d.getUTCDay() === 6 : false; };
  FC.dowShort = (iso) => { const d = FC.parseDate(iso); return d ? DOW[d.getUTCDay()] : ''; };
  FC.dayNum = (iso) => { const d = FC.parseDate(iso); return d ? d.getUTCDate() : ''; };
  FC.monShort = (iso) => { const d = FC.parseDate(iso); return d ? MON[d.getUTCMonth()] : ''; };
  // Rewrite pipeline lead codes in prose: "d9 (Wed 25 Nov)" -> "Wed 25 Nov"
  FC.dePlainLeads = (t) => String(t).replace(/\b[dw]\d+\s*\(([^)]+)\)/g, '$1').replace(/;\s*(\d+) of (\d+) leads/g, '; $1 of the $2 days and weeks shown');
  FC.fmtShort = (iso) => { const d = FC.parseDate(iso); return d ? MON[d.getUTCMonth()] + ' ' + d.getUTCDate() : ''; };
  FC.fmtLong = (iso) => { const d = FC.parseDate(iso); return d ? d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear() : (iso || ''); };
  FC.fmtRange = (a, b) => (a === b || !b ? FC.fmtDate(a) : FC.fmtShort(a) + '–' + FC.fmtShort(b));

  const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  FC.fmtNum = (v) => (v == null || !isFinite(v) ? '–' : nf0.format(v));
  FC.fmt1 = (v) => (v == null || !isFinite(v) ? '–' : nf1.format(v));
  // Display energy in GWh (source is MWh); peak stays MW
  FC.unitFor = (target, week) => (target === 'energy' ? (week ? 'GWh/week' : 'GWh/day') : 'MW');
  FC.scaleFor = (target) => (target === 'energy' ? 1 / 1000 : 1);
  FC.fmtVal = (v, target) => (v == null ? '–' : target === 'energy' ? FC.fmt1(v / 1000) : FC.fmtNum(v));

  FC.fmtPct = function (p) {
    if (p == null || !isFinite(p)) return '–';
    if (p <= 0) return '0%';
    if (p < 0.005) return '<1%';
    if (p >= 1) return '100%';
    if (p > 0.995) return '>99%';
    return Math.round(p * 100) + '%';
  };

  /* ---------- probability ramp (7 ordered bins) ---------- */
  FC.EDGES = [0.05, 0.10, 0.20, 0.35, 0.50, 0.75];
  FC.BIN_LABELS = ['<5', '5–10', '10–20', '20–35', '35–50', '50–75', '≥75'];
  FC.bin = (p) => {
    if (p == null || !isFinite(p)) return 'bna';
    let i = 0; while (i < FC.EDGES.length && p >= FC.EDGES[i]) i++;
    return 'b' + i;
  };
  FC.THRESH = {
    '90': { short: 'Top 10%', long: 'its top-10% level', base: 0.10 },
    '95': { short: 'Top 5%', long: 'its top-5% level', base: 0.05 },
    '99': { short: 'Top 1%', long: 'its top-1% level', base: 0.01 },
  };
  // one sequential ramp as a continuous bar, numeric ticks at the step edges (0 5 10 20 35 50 75 100%)
  FC.rampLegend = function () {
    const ticks = [0].concat(FC.EDGES, [1]);
    return FC.h('div', { class: 'ramp', role: 'img', 'aria-label': 'Colour scale for probability in seven steps: under 5%, 5 to 10, 10 to 20, 20 to 35, 35 to 50, 50 to 75, and 75% or more. Stronger colour means higher probability.' },
      FC.h('div', { class: 'ramp-bar', 'aria-hidden': 'true' }, FC.BIN_LABELS.map((l, i) => FC.h('span', { class: 'b' + i }))),
      FC.h('div', { class: 'ramp-ticks', 'aria-hidden': 'true' }, ticks.map((t, i) => {
        const el = FC.h('span', { text: Math.round(t * 100) + (i === ticks.length - 1 ? '%' : '') });
        el.style.setProperty('left', (i / (ticks.length - 1)) * 100 + '%');
        return el;
      })));
  };

  // Client-side staleness: a live issue more than 2 days older than today is flagged stale (replays never are)
  FC.checkStale = function (summary, L) {
    if (!summary || summary.kind === 'replay' || (L && L.cur && L.cur.kind === 'replay')) return summary;
    if (L && L.idx && L.idx.latest && L.cur && L.cur.issue !== L.idx.latest) return summary; // an archived run, chosen on purpose
    const d = FC.parseDate(summary.issue || (L && L.cur && L.cur.issue));
    if (!d) return summary;
    const now = new Date(), today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const age = Math.round((today - d.getTime()) / 864e5);
    if (age > 2 && !summary.stale) { summary.stale = true; summary.stale_since = summary.stale_since || summary.issue; summary.stale_age_days = age; }
    return summary;
  };

  // "26%" -> "about 1 in 4": plain odds for people who don't think in percentages
  FC.oneIn = function (p) {
    if (p == null || !isFinite(p)) return '';
    if (p < 0.035) return 'very unlikely';
    if (p > 0.965) return 'almost certain';
    const F = [[1, 20], [1, 10], [1, 8], [1, 6], [1, 5], [1, 4], [1, 3], [2, 5], [1, 2], [3, 5], [2, 3], [3, 4], [4, 5], [9, 10], [19, 20]];
    let best = F[0];
    for (const f of F) if (Math.abs(f[0] / f[1] - p) < Math.abs(best[0] / best[1] - p)) best = f;
    if (best[0] === 1 && best[1] === 2) return 'about even odds';
    return `about ${best[0]} in ${best[1]}`;
  };

  // Plain place names for headlines (short) and the operator behind each code (long)
  FC.PLACES = {
    PJM: ['the Mid-Atlantic and Ohio Valley', 'PJM Interconnection'], ERCO: ['Texas', 'ERCOT'], CISO: ['California', 'California ISO'],
    TVA: ['the Tennessee Valley', 'Tennessee Valley Authority'], NYIS: ['New York', 'New York ISO'], ISNE: ['New England', 'ISO New England'],
    FPL: ['South Florida', 'Florida Power & Light'], DUK: ['the western Carolinas', 'Duke Energy Carolinas'], CPLE: ['the eastern Carolinas', 'Duke Energy Progress'],
    BPAT: ['the Pacific Northwest', 'Bonneville Power Administration'], FPC: ['Central Florida', 'Duke Energy Florida'], LGEE: ['Kentucky', 'LG&E and KU'],
    SRP: ['Phoenix', 'Salt River Project'], LDWP: ['Los Angeles', 'LA Dept. of Water and Power'], SC: ['coastal South Carolina', 'Santee Cooper'],
    NEVP: ['Las Vegas', 'NV Energy (Nevada Power)'], PSEI: ['Puget Sound', 'Puget Sound Energy'], SCEG: ['central South Carolina', 'Dominion Energy South Carolina'],
    PGE: ['Portland', 'Portland General Electric'], AECI: ['Missouri', 'Associated Electric Cooperative'], TEC: ['Tampa', 'Tampa Electric'],
    IPCO: ['Idaho', 'Idaho Power'], JEA: ['Jacksonville', 'JEA'], SPPC: ['northern Nevada', 'NV Energy (Sierra Pacific)'], AVA: ['eastern Washington', 'Avista'],
    BANC: ['Sacramento', 'Balancing Authority of Northern California'], SCL: ['Seattle', 'Seattle City Light'], AEC: ['south Alabama', 'PowerSouth'],
    EPE: ['El Paso', 'El Paso Electric'],
  };
  FC.place = (ba) => (FC.PLACES[ba] ? FC.PLACES[ba][0] : ba);
  FC.joinAnd = (xs) => (xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);
  FC.cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  /* ---------- flags ---------- */
  FC.NO_FEED = {
    AEC: 'PowerSouth (AEC) has no live EIA-930 demand feed. The model runs without recent observed demand, so treat its forecasts as unreliable.',
    SPPC: 'Sierra Pacific (SPPC) has no live EIA-930 demand feed. The model runs without recent observed demand, so treat its forecasts as unreliable.',
  };
  FC.flagOf = function (summary, ba) {
    if (!summary) return null;
    const fb = summary.flagged_bas && summary.flagged_bas[ba];
    if (fb) return typeof fb === 'string' ? fb : 'Flagged';
    const b = (summary.bas || []).find((x) => x.ba === ba);
    return (b && b.flag) || null;
  };

  /* ---------- icons ---------- */
  const ICONS = {
    alert: 'M12 3 2.5 19.5h19L12 3ZM12 10v4.5M12 17.2v.1',
    info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 7.6v.1',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
    download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
    ext: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    back: 'M15 6l-6 6 6 6',
  };
  FC.icon = (name) => FC.s('svg', { class: 'ic', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }, FC.s('path', { d: ICONS[name] || '' }));

  /* ---------- issue header (shared by index + BA page) ---------- */
  FC.issueBadges = function (summary, entry) {
    const kind = (summary && summary.kind) || (entry && entry.kind);
    const out = [];
    if (kind === 'replay') out.push(FC.h('span', { class: 'badge badge-replay', text: 'Replay · hindcast' }));
    else if (kind === 'live') out.push(FC.h('span', { class: 'badge badge-live', text: 'Live forecast' }));
    if (summary && summary.stale) out.push(FC.h('span', { class: 'badge badge-warn', text: 'Stale' }));
    return out;
  };

  FC.metaList = function (summary) {
    const rows = [];
    const add = (k, v) => { if (v != null && v !== '') rows.push(FC.h('dt', { text: k }), FC.h('dd', { text: String(v) })); };
    add('Issued', summary.issue ? FC.fmtLong(summary.issue) : null);
    add('Data cutoff', summary.data_cutoff || null);
    add('Model', summary.model);
    add('Mode', summary.kind === 'replay' ? 'replay (past date re-run)' : summary.mode);
    add('Ensemble', summary.members ? summary.members + ' members' : null);
    return FC.h('dl', { class: 'meta' }, rows);
  };

  // Notes that must sit near the header: stale banner, replay explanation, live caveat
  FC.issueNotes = function (summary) {
    const out = [];
    if (summary.stale) {
      const since = summary.stale_since ? ' since ' + FC.fmtLong(summary.stale_since) : '';
      out.push(FC.h('div', { class: 'note note-warn', role: 'status' }, FC.icon('clock'),
        FC.h('div', null, FC.h('strong', { text: 'Stale forecast.' }),
          ` No new forecast has been produced${since}${summary.stale_age_days ? ' (' + summary.stale_age_days + ' days)' : ''}. The last good issue is shown.`)));
    }
    if (summary.kind === 'replay') {
      out.push(FC.h('div', { class: 'note note-info' }, FC.icon('info'),
        FC.h('div', null, FC.h('strong', { text: 'Replay (hindcast), not a live forecast. ' }),
          'The system was re-run as if on ' + FC.fmtLong(summary.issue) + ', using only data available then. Observed demand is shown so you can check it.')));
    }
    if (summary.caveat) {
      out.push(FC.h('div', { class: 'note note-warn' }, FC.icon('alert'),
        FC.h('div', null, FC.h('strong', { text: 'Run caveat: ' }), String(summary.caveat))));
    }
    return out;
  };

  // Fill an issue <select>; changing it reloads the page with ?issue=
  FC.fillIssueSelect = function (sel, issues, cur, extraParams) {
    sel.replaceChildren(...issues.map((i) => FC.h('option', { value: i.issue, selected: i.issue === cur.issue, text: i.label || i.issue })));
    sel.addEventListener('change', () => {
      const u = new URL(location.href);
      u.searchParams.set('issue', sel.value);
      if (extraParams) for (const k in extraParams) u.searchParams.set(k, extraParams[k]);
      location.href = u.pathname + u.search;
    });
  };

  // Demoted issue switcher: "Forecast issued <date>" + a disclosure listing past runs and replays
  FC.issueMenu = function (host, issues, cur, hrefFor) {
    const h = FC.h;
    const desc = (i) => {
      const lbl = String(i.label || i.issue).replace(/^(Live|Replay):\s*/i, '');
      return i.kind === 'replay'
        ? { title: lbl, sub: 'Hindcast, re-run as if issued ' + FC.fmtLong(i.issue) + '. Shows what actually happened.' }
        : { title: 'Live forecast of ' + FC.fmtLong(i.issue), sub: i.issue === issues[0].issue ? 'The most recent run.' : 'An earlier live run.' };
    };
    const det = h('details', { class: 'issues-menu' },
      h('summary', null, 'Past forecasts and replays'),
      h('ul', { class: 'issues-list' }, issues.map((i) => {
        const d = desc(i), here = i.issue === cur.issue;
        return h('li', null, h('a', { href: hrefFor(i.issue), 'aria-current': here ? 'true' : null },
          h('span', { class: 'il-top' }, h('b', { text: d.title }), i.kind === 'replay' ? h('span', { class: 'badge badge-replay', text: 'Hindcast' }) : h('span', { class: 'badge badge-live', text: 'Live' })),
          h('small', { text: d.sub + (here ? ' You are viewing this one.' : '') })));
      })));
    const kind = cur.kind === 'replay' ? 'Hindcast of a forecast issued ' : 'Forecast issued ';
    host.replaceChildren(h('p', { class: 'issued' }, kind, h('time', { datetime: cur.issue, text: FC.fmtWords(cur.issue, true) })), det);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && det.open) { det.open = false; det.querySelector('summary').focus(); } });
    document.addEventListener('click', (e) => { if (det.open && !det.contains(e.target)) det.open = false; });
    return det;
  };

  FC.baHref = (ba, issue) => `ba.html?ba=${encodeURIComponent(ba)}&issue=${encodeURIComponent(issue)}`;

  /* ---------- theme + nav ---------- */
  function initTheme() {
    const btn = FC.$('#themeToggle');
    if (!btn) return;
    const root = document.documentElement;
    const sync = () => {
      const light = root.getAttribute('data-theme') === 'light';
      btn.setAttribute('aria-pressed', light ? 'true' : 'false');
      btn.setAttribute('aria-label', 'Light theme');
      btn.title = light ? 'Switch to dark theme' : 'Switch to light theme';
    };
    btn.addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('fc-theme', next); } catch (e) { /* ignore */ }
      sync();
      document.dispatchEvent(new CustomEvent('fc:theme'));
    });
    sync();
  }
  function initNav() {
    const nav = FC.$('#nav'), t = FC.$('#navToggle');
    if (!nav || !t) return;
    const set = (open) => { nav.classList.toggle('open', open); t.setAttribute('aria-expanded', open ? 'true' : 'false'); t.setAttribute('aria-label', open ? 'Close menu' : 'Open menu'); };
    t.addEventListener('click', () => set(!nav.classList.contains('open')));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && nav.classList.contains('open')) { set(false); t.focus(); } });
    FC.$$('.nav-links a').forEach((a) => a.addEventListener('click', () => set(false)));
  }
  // Keep ?issue= on internal nav links so moving between pages keeps context
  function carryIssue() {
    const iss = FC.safeIssue(FC.params.get('issue'));
    if (!iss) return;
    FC.$$('a[data-carry]').forEach((a) => {
      const u = new URL(a.getAttribute('href'), location.href);
      u.searchParams.set('issue', iss);
      a.setAttribute('href', u.pathname.split('/').pop() + u.search + u.hash);
    });
  }

  FC.onResize = function (el, fn) {
    let w = el.clientWidth, raf = 0;
    const ro = new ResizeObserver(() => {
      if (Math.abs(el.clientWidth - w) < 2) return;
      w = el.clientWidth;
      cancelAnimationFrame(raf); raf = requestAnimationFrame(fn);
    });
    ro.observe(el);
  };

  document.addEventListener('DOMContentLoaded', () => {
    initTheme(); initNav(); carryIssue();
    const y = FC.$('#year'); if (y) y.textContent = String(new Date().getFullYear());
  });
})();
