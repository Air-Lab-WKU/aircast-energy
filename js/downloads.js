/* Downloads: list the newest run's files and the archive of runs from issues.json. */
(function () {
  'use strict';
  const FC = window.FC, h = FC.h;
  document.addEventListener('DOMContentLoaded', async () => {
    let idx;
    try { idx = await FC.getJSON('issues.json'); } catch (e) { FC.errorBox(FC.$('#latest'), e); FC.$('#archive').replaceChildren(); return; }
    const issues = (Array.isArray(idx.issues) ? idx.issues : []).filter((i) => i && FC.safeIssue(i.issue));
    const latest = issues.find((i) => i.issue === idx.latest) || issues[0];
    if (!latest) { FC.$('#latest').textContent = 'No runs published yet.'; return; }
    const base = FC.DATA + latest.issue + '/';
    FC.$('#citeIssue').textContent = latest.issue;
    let bas = [];
    try { bas = ((await FC.getJSON(latest.issue + '/summary.json')).bas || []).map((b) => b && b.ba).filter((ba) => typeof ba === 'string' && ba && FC.safeId(ba) === ba).sort(); } catch (e) { /* list stays short */ }
    FC.$('#latest').replaceChildren(
      h('p', null, `Issued ${FC.fmtWords(latest.issue, true)}, `, latest.kind === 'replay' ? h('strong', { text: 'a hindcast (replay)' }) : h('strong', { text: 'a live forecast' }), `, model ${latest.model || 'operational_v1'}.`),
      h('ul', { class: 'dl-list' },
        h('li', null, h('a', { href: base + 'forecast_all.csv', download: `forecast_all_${latest.issue}.csv` }, FC.icon('download'), 'All areas, CSV'), h('small', { text: 'forecast_all.csv, every area, quantity and day' })),
        h('li', null, h('a', { href: base + 'summary.json' }, FC.icon('download'), 'Run summary, JSON'), h('small', { text: 'summary.json' })),
        h('li', null, h('a', { href: base + 'risk.json' }, FC.icon('download'), 'Chances by area and day, JSON'), h('small', { text: 'risk.json' }))),
      bas.length ? h('details', { class: 'tech' }, h('summary', null, `One file per area (${bas.length})`),
        h('ul', { class: 'ba-files' }, bas.map((b) => h('li', null, h('a', { href: base + b + '.csv', download: `${b}_${latest.issue}.csv`, text: b + '.csv' }), ' ', h('a', { href: base + b + '.json', text: 'JSON' }))))) : null);
    FC.$('#archive').replaceChildren(h('ul', { class: 'archive' }, issues.map((i) => h('li', null,
      h('span', { class: 'badge ' + (i.kind === 'replay' ? 'badge-replay' : 'badge-live'), text: i.kind === 'replay' ? 'Hindcast' : 'Live' }),
      h('span', null, h('b', { text: String(i.label || i.issue).replace(/^(Live|Replay):\s*/i, '') }), ` · issued ${FC.fmtLong(i.issue)}`),
      h('a', { href: FC.DATA + i.issue + '/forecast_all.csv', download: `forecast_all_${i.issue}.csv`, text: 'CSV' }),
      h('a', { href: 'index.html?issue=' + encodeURIComponent(i.issue), text: 'Map' })))));
  });
})();
