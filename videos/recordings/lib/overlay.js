// Injected into every recorded page (Playwright addInitScript). Draws a
// subtle cursor that follows the real mouse events Playwright sends, and a
// ripple on each click, so viewers can follow what is pressed. It never
// changes the page's own UI: one fixed, pointer-events-free layer on top.
(() => {
  if (window.__cairnOverlay) return;
  window.__cairnOverlay = true;
  const css = `
    #__rec-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
      width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%;
      background: rgba(242, 181, 58, 0.28); border: 2px solid rgba(242, 181, 58, 0.95);
      box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35); transition: transform 120ms ease, opacity 200ms ease; opacity: 0; }
    #__rec-cursor.down { transform: scale(0.8); }
    .__rec-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 16px; height: 16px;
      margin: -8px 0 0 -8px; border-radius: 50%; border: 2px solid rgba(242, 181, 58, 0.9);
      animation: __rec-ripple 520ms ease-out forwards; }
    @keyframes __rec-ripple { to { transform: scale(3.4); opacity: 0; } }`;
  const install = () => {
    if (document.getElementById('__rec-cursor')) return;
    const style = document.createElement('style');
    style.textContent = css;
    document.documentElement.appendChild(style);
    const cursor = document.createElement('div');
    cursor.id = '__rec-cursor';
    document.documentElement.appendChild(cursor);
    const at = (e) => { cursor.style.translate = `${e.clientX}px ${e.clientY}px`; cursor.style.opacity = '1'; };
    window.addEventListener('mousemove', at, true);
    window.addEventListener('mousedown', (e) => {
      at(e);
      cursor.classList.add('down');
      const ripple = document.createElement('div');
      ripple.className = '__rec-ripple';
      ripple.style.left = `${e.clientX}px`;
      ripple.style.top = `${e.clientY}px`;
      document.documentElement.appendChild(ripple);
      setTimeout(() => ripple.remove(), 600);
    }, true);
    window.addEventListener('mouseup', () => cursor.classList.remove('down'), true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
