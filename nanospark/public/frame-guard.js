/*
 * Clickjacking guard.
 *
 * The strong fix is the `frame-ancestors 'none'` response header, but static
 * hosts such as GitHub Pages cannot send custom headers, and browsers ignore
 * frame-ancestors in a <meta> CSP. So the page ships hidden (the inline
 * #frame-guard style in index.html) and is only revealed here, when it is
 * provably the top-level window.
 *
 * Framed by another site, the page stays blank and tries to break out. A
 * sandboxed frame that blocks scripts never runs this, so it stays blank too;
 * one that allows scripts but blocks top navigation also stays blank. There is
 * no state in which the wallet renders inside someone else's frame.
 *
 * Loaded as a classic, blocking script before anything else, from 'self', so
 * the CSP needs no 'unsafe-inline' for scripts.
 */
(function () {
  var framed;
  try {
    framed = window.top !== window.self;
  } catch (e) {
    framed = true;
  }
  if (!framed) {
    var guard = document.getElementById("frame-guard");
    if (guard && guard.parentNode) guard.parentNode.removeChild(guard);
    return;
  }
  window.__nanosparkFramed = true;
  try {
    window.top.location = window.self.location.href;
  } catch (e) {
    /* navigation blocked: the page simply stays hidden */
  }
})();
