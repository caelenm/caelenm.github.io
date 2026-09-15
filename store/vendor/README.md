# vendor/

Third-party code, committed deliberately rather than fetched at runtime.

## openpgp.min.mjs

- **Version:** 6.3.1
- **Source:** the `openpgp` npm package, `dist/openpgp.min.mjs` (the browser build)
- **sha256:** `6bd32571c519dca96e7e2be6c7a578a12cd60d18f05a07af1a1475e1d34bbd03`
- **Licence:** LGPL-3.0-or-later — see `openpgp-LICENSE.txt`

It is vendored rather than loaded from a CDN so the store's Content Security Policy can keep
`script-src 'self'`: no third-party code ever runs on your page, and the store keeps working if a
CDN does not.

It is loaded **lazily**, only when an order actually has to be encrypted or when you paste a key
into Store settings. A shopper browsing the catalogue never downloads it.

To update it:

```sh
npm pack openpgp@<version>
tar -xf openpgp-<version>.tgz
cp package/dist/openpgp.min.mjs vendor/openpgp.min.mjs
sha256sum vendor/openpgp.min.mjs        # record the new hash above
```
