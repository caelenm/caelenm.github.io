/*
 * Service worker — installability and an honest offline screen. Nothing else.
 *
 * Chrome will not offer "Install" without a service worker that has a fetch
 * handler, which is the only reason this file exists. It is deliberately the
 * smallest thing that satisfies that.
 *
 * It caches NOTHING. A wallet's whole security rests on the code the browser
 * runs being the code the server sent, and a cache-first service worker breaks
 * exactly that: a poisoned or merely stale build survives reloads and keeps
 * running against the user's seed, invisibly, until the worker happens to
 * update. Going to the network every time costs a few hundred milliseconds on
 * launch and removes that entire class of problem.
 *
 * There is also nothing to gain offline. Every useful action — balances,
 * sending, claiming — needs the operators, so an offline wallet has nothing to
 * offer but a blank screen. It says so instead, with a way back.
 *
 * The offline page is built from this string rather than cached, so the claim
 * above stays literally true: the Cache API is never used, and the activate
 * handler deletes anything an earlier version might have left behind.
 */

const OFFLINE_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#0c0d10" />
    <title>sparknote — offline</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0; min-height: 100dvh; display: flex; align-items: center; justify-content: center;
        background: #0c0d10; color: #e8e8ea; padding: 24px;
        font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      }
      main { max-width: 22rem; text-align: center; }
      h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
      p { margin: 0 0 1.25rem; color: #9a9aa2; font-size: .9375rem; }
      a {
        display: block; padding: 12px 16px; border-radius: 10px;
        background: #f7931a; color: #0c0d10; font-weight: 600; text-decoration: none;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>You're offline</h1>
      <p>
        sparknote needs a connection — balances, payments and claims all come from the Spark
        operators, so there is nothing it can do offline. Your wallet is untouched.
      </p>
      <!-- A link, not a button: no inline script, so this renders under any CSP. -->
      <a href=".">Try again</a>
    </main>
  </body>
</html>`;

self.addEventListener("install", () => {
  // Take over immediately; there is no cached state to migrate carefully.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Belt and braces: if any earlier build ever cached anything, drop it.
      if (self.caches) {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Only page loads get the offline screen. Everything else — scripts, the
  // SDK's calls to the operators — is left entirely alone: not intercepted,
  // not rewritten, not cached. Their failures belong to the app, which already
  // reports them properly.
  if (request.mode !== "navigate") return;

  event.respondWith(
    fetch(request).catch(
      () =>
        new Response(OFFLINE_PAGE, {
          status: 503,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        }),
    ),
  );
});
