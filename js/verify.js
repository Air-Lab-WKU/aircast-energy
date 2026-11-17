/* Verification: replay (hindcast) scoring computed in the browser from the published JSON.
   Coverage of the 5-95% range by lead, and caught / missed / false-alarm counts for top-10% peak days. */
(function () {
  'use strict';
  const FC = window.FC, h = FC.h;
  const st = { target: 'peak', replays: [], leads: [] };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    let L;
    try { L = await FC.loadIssues(); } catch (e) { return FC.errorBox(FC.$('#vSummary'), e); }
    const live = L.issues.filter((i) => i.kind === 'live');
    if (live.length) {
      const first = live[live.length - 1].issue;
      FC.$('#liveText').textContent = `Live verification starts once about 30 days of forecast targets have matured. The first live run on this site was issued on ${FC.fmtWords(first, true)}, so scoring can begin about a month after that. A day's forecast can only be scored once that day has passed and its demand data is published.`;
    }
    const reps = L.issues.filter((i) => i.kind === 'replay' && FC.safeIssue(i.issue));
    if (!reps.length) { FC.$('#vSummary').replaceChildren(h('p', { text: 'No replays are published yet.' })); return; }
    // one missing replay must not blank the page: each replay fails on its own
    st.replays = (await Promise.all(reps.map(async (r) => {
      const sm = await FC.getJSON(r.issue + '/summary.json');
      const codes = (sm.bas || []).map((b) => b && b.ba).filter((ba) => typeof ba === 'string' && ba && FC.safeId(ba) === ba);
      const docs = await Promise.all(codes.map((ba) => FC.getJSON(r.issue + '/' + ba + '.json').catch(() => null)));
      return { entry: r, sm, docs: docs.filter(Boolean) };
    }).map((p) => p.catch(() => null)))).filter(Boolean);
    if (!st.replays.length) return FC.errorBox(FC.$('#vSummary'), new Error('None of the published replays could be loaded.'));
    FC.$$('input[name="vt"]').forEach((i) => i.addEventListener('change', () => { st.target = i.value; render(); }));
    render();
    FC.onResize(FC.$('#cov'), render);
  }

  function rowsOf(doc, target) {
    const T = doc.targets && doc.targets[target]; if (!T) return [];
    const out = [];
    ['d', 'w'].forEach((kind) => (T[kind] || []).forEach((r) => out.push({ key: FC.leadKey(r.lead, kind), r })));
    return out;
  }

  function render() {
    const target = st.target;
    // coverage by lead, pooled
    const leadOrder = [];
    const cov = new Map();
    st.replays.forEach((rep) => rep.docs.forEach((doc) => rowsOf(doc, target).forEach(({ key, r }) => {
      if (r.observed == null || r.q['05'] == null || r.q['95'] == null) return;
      if (!cov.has(key)) { cov.set(key, { n: 0, in: 0 }); leadOrder.push(key); }
      const c = cov.get(key); c.n++; if (r.observed >= r.q['05'] && r.observed <= r.q['95']) c.in++;
    })));
    const sortKey = (k) => (k[0] === 'd' ? 0 : 100) + +k.slice(1);
    leadOrder.sort((a, b) => sortKey(a) - sortKey(b));
    const rows = leadOrder.map((k) => ({ key: k, label: k[0] === 'd' ? 'Day ' + k.slice(1) : 'Wk ' + k.slice(1), v: cov.get(k).n ? cov.get(k).in / cov.get(k).n : null, n: cov.get(k).n }));
    const leadName = (r) => (r.key[0] === 'd' ? `${r.key.slice(1)} day${r.key === 'd1' ? '' : 's'} ahead` : `Week ${r.key.slice(1)}`);
    FC.dotChart(FC.$('#cov'), rows.map((r) => ({ label: r.key[0] === 'd' ? r.key.slice(1) : 'W' + r.key.slice(1), v: r.v })), {
      ref: 0.9, refLabel: 'Ideal 90%', yLabel: 'Inside 90% range', xLabel: 'Days ahead, then weeks',
      aria: `Share of observed values inside the forecast's 90% range (5th to 95th percentile), by lead, ${target}. Use the arrow keys to read each lead.`,
      strip: (i) => [
        { k: 'Lead', v: leadName(rows[i]), cls: 'cx-date' },
        { k: 'Inside 90% range', v: FC.fmtPct(rows[i].v), cls: 'cx-med' },
        { k: 'Ideal', v: '90%' },
        { k: rows[i].key[0] === 'd' ? 'Area-days' : 'Area-weeks', v: FC.fmtNum(rows[i].n) },
      ],
      onCursor: (i, why) => {
        if (why !== 'key' && why !== 'init') return;
        const r = rows[i];
        FC.$('#covRead').replaceChildren(h('b', { text: leadName(r) }), `: the observed value was inside the 90% range ${FC.fmtPct(r.v)} of the time (${r.n} area-${r.key[0] === 'd' ? 'days' : 'weeks'}). Ideal is about 90%.`);
      },
    });

    const days = rows.filter((r) => r.key[0] === 'd');
    const pooled = days.reduce((a, r) => { const c = cov.get(r.key); a.n += c.n; a.in += c.in; return a; }, { n: 0, in: 0 });
    const covAll = pooled.n ? pooled.in / pooled.n : null;

    // events table (peak only: energy has no probabilities)
    const evRows = st.replays.map((rep) => {
      let ev = 0, hit = 0, miss = 0, fa = 0, n = 0, cin = 0, cn = 0;
      rep.docs.forEach((doc) => {
        if (FC.flagOf(rep.sm, doc.ba)) return;
        rowsOf(doc, 'peak').forEach(({ key, r }) => {
          if (key[0] !== 'd' || r.observed == null) return;
          if (r.q['05'] != null) { cn++; if (r.observed >= r.q['05'] && r.observed <= r.q['95']) cin++; }
          if (!r.t || r.t['90'] == null || !r.p || r.p['90'] == null) return;
          n++;
          const happened = r.observed > r.t['90'], said = r.p['90'] >= 0.5;
          if (happened) { ev++; if (said) hit++; else miss++; } else if (said) fa++;
        });
      });
      return { rep, ev, hit, miss, fa, n, cov: cn ? cin / cn : null };
    });
    const tot = evRows.reduce((a, r) => ({ ev: a.ev + r.ev, hit: a.hit + r.hit, miss: a.miss + r.miss, fa: a.fa + r.fa, n: a.n + r.n }), { ev: 0, hit: 0, miss: 0, fa: 0, n: 0 });

    const sum = [h('p', { class: 'v-line' },
      `Across ${st.replays.length} replays, the actual ${target === 'energy' ? 'daily energy' : 'daily peak'} landed inside the forecast's nine-in-ten range on `,
      h('strong', { text: FC.fmtPct(covAll) }), ` of area-days in the first 14 days (ideal is about 90%).`)];
    if (target === 'peak' && tot.ev) {
      sum.push(h('p', { class: 'v-line' },
        `Of `, h('strong', { text: String(tot.ev) }), ` unusually high days that happened, the forecast gave `, h('strong', { text: String(tot.hit) }),
        ` a 50% chance or more (${FC.fmtPct(tot.hit / tot.ev)}). It also gave 50% or more on `, h('strong', { text: String(tot.fa) }), ` days that turned out ordinary.`));
    }
    if (target === 'energy') sum.push(h('p', { class: 'v-line muted-sm', text: 'Energy has no top-10% levels, so only the range check applies.' }));
    FC.$('#vSummary').replaceChildren(...sum);

    const tbl = h('table', { class: 'data' },
      h('caption', { class: 'sr-only', text: 'Replay results by event' }),
      h('thead', null, h('tr', null, ['Replay', 'Unusually high days', 'Caught (50%+)', 'Missed', 'False alarms', 'Inside 90% range', ''].map((c) => h('th', { scope: 'col', text: c })))),
      h('tbody', null, evRows.map((r) => h('tr', null,
        h('th', { scope: 'row', class: 'txt' }, String(r.rep.entry.label || r.rep.entry.issue).replace(/^Replay:\s*/i, ''), h('small', { class: 'cell-sub', text: 'issued ' + FC.fmtLong(r.rep.entry.issue) })),
        h('td', { text: String(r.ev) }), h('td', { text: String(r.hit) }), h('td', { text: String(r.miss) }), h('td', { text: String(r.fa) }),
        h('td', { text: FC.fmtPct(r.cov) }),
        h('td', { class: 'txt' }, h('a', { href: 'index.html?issue=' + encodeURIComponent(r.rep.entry.issue), text: 'Open on the map' }))))));
    FC.$('#evTable').replaceChildren(tbl);
  }
})();
