// Applies a saved light/dark choice before the app boots, so the page does
// not flash the other theme. No choice saved = follow the OS (styles.css).
(function () {
  try {
    var t = localStorage.getItem('platform.theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: follow the OS */ }
})();
