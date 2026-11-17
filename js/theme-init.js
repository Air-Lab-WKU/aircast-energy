// Applies a saved theme before first paint (external file so the CSP can stay script-src 'self').
(function () {
  try {
    var t = localStorage.getItem('fc-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: follow the default (dark) */ }
})();
