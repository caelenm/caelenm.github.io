# satstore

A self-hosted store page that takes bitcoin Lightning payments. No build step, no backend,
no accounts. Drop it on any static host and manage it by editing a git repo.

```
index.html               the entire app
config.json              products and settings         (signed)
inventory.json           stock quantities              (not signed — changes per sale)
config_hash.txt          sha256 of config.json         ) created by
config_hash.sig          your Bitcoin signature        ) setup-verification.sh
setup-verification.sh    one-time attestation setup
updateinventory.sh       decrement stock after a sale, commit, push
serve.mjs                local dev server
```

---

## What a static site can and cannot do

The design follows from one constraint: **a static host returns files, and the browser runs
JavaScript.** Anything reachable by an HTTPS request to a CORS-enabled third party is possible.
Anything needing a secret, writable shared storage, or trust that the client didn't lie is not.

### Done entirely in the browser

| Capability | How |
|---|---|
| Catalogue, cart, totals, cashier | `config.json` + `localStorage` |
| **Invoice generation** | LUD-16 lightning address → `GET /.well-known/lnurlp/<name>` → `GET callback?amount=` → bolt11 |
| **Live "Paid!"** | LUD-21: the callback returns a `verify` URL; the page polls it until `settled` |
| Payment proof without a server | `sha256(preimage) === payment_hash` via `crypto.subtle` |
| Order number | First 8 hex of the invoice's `payment_hash` — unique, and searchable in your wallet |
| **Store attestation** | BIP-137 signature verification, secp256k1 recovery done in-page |
| Fiat pricing | Bull Bitcoin → Kraken → Coinbase → blockchain.info, first to answer wins |
| QR codes, print/PDF receipts | Built in; printing uses the browser's own dialog |

### Not possible without a server

| Wanted | Why not | What this does instead |
|---|---|---|
| Email the order automatically | Sending mail needs a secret, which cannot live in public JS | `mailto:` + copy JSON; optional third-party form endpoint |
| Enforced stock | Two buyers cannot be sequenced without shared writable state | Advisory counts in `inventory.json`; your wallet is the ledger |
| Trusting "Paid!" | A visitor can edit the page's JavaScript | The page generates receipts; **your wallet is the source of truth** |
| Hiding the config editor | No login means anyone can open it | Their edits only touch their own browser; publishing means committing a file |

---

## Setup

```bash
node serve.mjs        # http://localhost:8123 — dev only; any static host works in production
```

Open the site, click **Set up store config**, and fill in your lightning address, currency and
products. Then **Publish** → download `config.json` → commit it.

Everything else is optional.

### Pick a provider that supports LUD-21

Live "Paid!" needs the payment provider to return a `verify` URL. **Alby, LNbits, Coinos and
phoenixd do.** Without it the page still works — the buyer pastes the preimage from their wallet
and it is verified cryptographically against the invoice — but nothing updates on its own. The
**Test connection** button in Store settings tells you which you'll get.

---

## Store verification (optional, recommended)

This is what makes the green **Store details verified** light appear, and what lets you check
orders later. It is worth being precise about what it does and does not prove.

```bash
./setup-verification.sh          # interactive
./setup-verification.sh --check  # confirm what is on disk
```

The script writes your signing address and canonical URL into `config.json`, hashes the file,
and prints the hash for you to sign in **Electrum, Sparrow, or Bitcoin Core**. Paste the
signature back and it writes `config_hash.txt` and `config_hash.sig`. Commit all three.

**Your private key never touches this project.** The script only records a signature you make
in your own wallet.

Supported address types: `1…` (P2PKH), `3…` (P2SH-P2WPKH), `bc1q…` (native segwit).
Taproot (`bc1p…`) needs BIP-322 and is not supported.

### What the green light actually means

The page hashes the `config.json` **it was served**, fetches `config_hash.sig` from the
**canonical URL** baked into that config, and checks the signature against your address.

- ✅ It detects a stale mirror, or a clone that edited prices or the lightning address — the
  served config stops hashing to the signed canonical value.
- ❌ It does **not**, by itself, stop someone who forks everything including the canonical URL.
  They would show green for *their* address.

That is why the signing address is always displayed, and why a buyer can **pin** an address they
got from you out-of-band — on a business card, an invoice, a physical shop sign. **The pin is the
only real trust anchor; everything else is tamper-evidence.** Publish your signing address
somewhere other than the store itself.

When attestation fails, checkout shows a blocking red notice: *orders placed against a store that
does not match its published config will not be fulfilled.*

**Re-run the script every time you change `config.json`** — the hash changes and the old
signature stops matching.

---

## How the order reaches you

Paying an invoice moves money. It carries **no information about what was ordered**. The buyer is
told this before paying and must tick a box acknowledging it.

After payment they get an **order JSON** — the authoritative record, carrying items, quantities,
totals, invoice, payment hash, preimage, config hash and customer details — with a `mailto:` link,
a copy button, a print/PDF button, and an optional receipt QR.

**Optional automatic delivery:** set a **form endpoint URL** in Store settings and the order is
POSTed there on payment. The integration is deliberately provider-neutral — a `FormData` POST of
flat named fields, which avoids a CORS preflight and which all of these accept:

| Provider | Endpoint | Extra field |
|---|---|---|
| Web3Forms | `https://api.web3forms.com/submit` | `access_key` |
| Formspree | `https://formspree.io/f/<id>` | — |
| FormSubmit | `https://formsubmit.co/ajax/<email>` | — |
| Basin | `https://usebasin.com/f/<id>` | — |
| Getform | `https://getform.io/f/<id>` | — |

Switching provider is a URL change. If the POST fails the page falls back to the email button, so
an outage cannot silently lose an order.

### Verifying an order you received

**Store config → Verify an order.** Paste the customer's order JSON and the URL of your canonical
config. It runs in your browser and checks:

1. the order schema is recognised
2. the canonical config is reachable, and its hash
3. the order was placed against **that exact config**
4. the order names your lightning address
5. the preimage really pays the stated payment hash
6. the invoice decodes, and its amount matches the order total
7. **the invoice was issued by your node**
8. every item price matches your catalogue

Any mismatch is reported explicitly. A price-manipulated or phantom-item order fails here.

### Why the node ID field matters

Check 4 is weak on its own, and the tool says so. `lightning_address` is a string written by the
buyer's browser — a claim, not evidence. Everything else in an order can be genuine while the
money went somewhere else entirely:

> An attacker buys nothing from you. They pay **their own** node 9 sats and keep the real
> preimage, then send you an order JSON carrying your address, your config hash, your catalogue
> prices, and that genuine invoice and preimage. Checks 1–6 and 8 all pass.

Check 7 stops it. Every BOLT-11 invoice is signed by the node that issued it, and the node ID is
recoverable from that signature, so an invoice cannot be re-attributed to another node without
invalidating it. Paste your node ID once — or press **Detect from my lightning address**, which
reads it off a throwaway invoice — and a forged order fails on the one check that cannot be
faked.

Leave the field blank and the tool still reports the issuing node, just without judging it. An
order arriving with **no invoice at all** is flagged as a failure: without it, nothing ties the
payment to you.

---

## Encrypting orders (optional)

**Store config → Store settings → Secure order details.** Paste your OpenPGP public key and turn
on encryption. From then on, the copy of each order that travels to you is encrypted to that key,
so it is unreadable to your form provider, your mail provider, and anyone with access to the
buyer's outbox.

```sh
gpg --armor --export you@example.com     # paste the output into the field
```

**The buyer always keeps a plain-text copy of their own order** — encryption only protects the
copy in transit to you. Their page shows the key's fingerprint and identity so you can confirm
you pasted the right one; publish that fingerprint somewhere buyers can check it.

Because ciphertext is far too long for a `mailto:` body, the buyer gets a **Copy encrypted order**
button and an email button that copies the block to their clipboard first and opens a short
message for them to paste into. With a form endpoint configured, delivery stays fully automatic
and the customer's name and email are no longer sent as separate plain fields — only the order
number identifies the ciphertext.

Decrypt what arrives with:

```sh
gpg --decrypt order.asc
```

`openpgp.js` is vendored in `vendor/` rather than loaded from a CDN, so no third-party code runs
on your page, and it is imported lazily — a shopper browsing the catalogue never downloads it.

### Why this is a second key, not a replacement

The Bitcoin signing address and the PGP key are kept separate on purpose, because their exposure
is opposite:

| | lives where | used when |
|---|---|---|
| **Bitcoin signing key** | offline, hardware wallet | only when `config.json` changes |
| **PGP private key** | on whatever machine you read orders on | every order |

Folding both into one key would force your attestation key to become a warm, daily-use key. There
is a second benefit to the split: the Bitcoin signature covers `config.json`, and your PGP
**public** key lives in that file — so the attestation protects the encryption key from being
quietly swapped for an attacker's.

## Inventory

Turn on **Store config → Inventory → Track inventory quantities**. Stock lives in
`inventory.json`, **deliberately outside the signed config**, because it changes on every sale —
otherwise you would have to re-sign with your wallet after each order. That also means stock
counts are not attested.

A static site cannot stop two people buying the last item at the same moment. Counts are advisory:
they show "only N left", hide sold-out items, and cap what a buyer can add to their cart.

```bash
./updateinventory.sh order.json           # apply an order (a saved .json file)
./updateinventory.sh '<order json>'       # or paste the JSON directly
./updateinventory.sh sticker -5 mug -2    # manual adjustment
./updateinventory.sh --set tee 20         # absolute quantity
./updateinventory.sh --show               # print current stock
```

Flags: `--yes` skip prompts, `--no-push` file only, `--dry-run` preview.

It updates the file, shows a before/after table, warns on unknown ids and clamps negatives, then
offers to commit and push. **Authentication uses whatever git already has** — credential manager,
SSH key, or `gh`. If `GITHUB_TOKEN` is set it is used for that one push and is never written to
disk or into `.git/config`; it is redacted from error output.

---

## Cashier (in-person sales)

**Tap the store icon four times.** Tally items, take payment, done — same invoice and settlement
path as the online cart, minus the shipping questions. The buyer can save a receipt QR as proof.

Hidden rather than secret: it keeps a staff tool out of shoppers' way, nothing more.

---

## Appearance

Store settings covers accent colour, **background colour**, and a **custom store icon** replacing
the lightning bolt. Leave the background blank and the page follows the visitor's light/dark
setting; set one and the palette flips to whichever stays readable on it.

---

## Security model

This repo is meant to be published. Everything in it is public, including `config.json`, and the
design assumes that.

**What is safe to commit**

- Your lightning address and order email. Both are published on purpose.
- Your Bitcoin signing address. It is a public key hash; the private key stays in your wallet.
- `config_hash.txt` and `config_hash.sig`. A signature is meant to be read.

**What must never go in this repo**

- A wallet seed, private key, or NWC connection string.
- Any API token that is not explicitly documented as publishable.
- Real customer orders. They contain names, emails and addresses.

**Your form-endpoint key is public, and that has a consequence.** Services like Web3Forms
document their access key as safe for client-side use, and it is — it cannot read your mail. But
once published, anyone can POST to that endpoint with your key, so the realistic abuse is inbox
spam to your order address. Use the provider's spam controls, and rotate the key if it is abused.
This is inherent to sending mail from a page with no backend, not a flaw in this project.

**The admin panel is open by design.** There is no login, so anyone can open Store config. That
is not a hole: their edits are written to their own browser's `localStorage` and cannot reach
your published `config.json`, which only changes when you commit a file. Treat the editor as a
local scratchpad that happens to be reachable by everyone.

**Hardening that is in place**

- A Content Security Policy ships in the page: no third-party scripts, no plugins, no `<base>`
  rewriting, no HTML form posting anywhere. `'unsafe-inline'` is unavoidable because the app is
  one inline module.
- `referrer` is set to `no-referrer`, so lightning and rate providers do not learn which page
  the request came from.
- All rendering builds DOM nodes; config text is never interpolated into HTML.
- Config keys that would rewrite an object's prototype (`__proto__`, `constructor`, `prototype`)
  are dropped when the config is read.
- `updateinventory.sh` passes `GITHUB_TOKEN` to git through a one-shot credential helper, so the
  token never reaches `.git/config`, a remote URL, or the process argument list.

**Hardening you have to do at the host**, because a static page cannot set response headers:
serve over HTTPS, and set `Content-Security-Policy: frame-ancestors 'none'` (or
`X-Frame-Options: DENY`) to stop the store being framed.

**A stale `config.js` is a trap.** It is only read when `config.json` cannot be fetched, so an
out-of-date copy sits silently until the day it is not — and then it quietly serves the old
prices and the old lightning address. Regenerate it whenever you publish, or do not keep one.

**What a buyer's browser stores:** their cart, their last 25 orders (including the name, email
and address they typed), and any config draft. All of it stays on their device; none of it is
sent anywhere except the order they choose to send you.

## Tests

```bash
node test/payment.test.mjs      # 67 checks on payment confirmation
node test/payee.test.mjs        # 17 checks on payee node id recovery
node test/ordernumber.test.mjs  # 23 checks on order numbering
```

The payment watcher is extracted verbatim from the `<paywatch>` region of `index.html`, so the
tests exercise shipped code rather than a copy. Time and network are injected, so an hour-long
invoice runs instantly. Covered: the exact 5-second cadence, settlement detected at any point
including 20 minutes in, never reporting paid while unsettled, surviving long outages, backing off
without giving up, continuing to check past expiry, stopping cleanly after the grace window,
immediate re-check on tab refocus with no overlapping requests, and eleven provider response
shapes.

## Verification of the code itself

The cryptographic pieces are hand-rolled to keep the site dependency-free, and each was tested
against a reference implementation rather than trusted:

- **QR encoder** — 543 structural comparisons against the `qrcode` package, plus **410
  encode→decode round-trips through `jsQR`, zero failures**, across ECC levels L/M/Q/H, byte and
  alphanumeric modes, 1–1200 characters, and UTF-8.
  <br>*Mask selection intentionally differs from `qrcode`, whose N4 penalty rule
  (`|ceil(pct/5) − 10|`) deviates from the spec's `floor(|pct − 50|/5)`. Mask choice never affects
  decodability.*
- **bolt11 reader** — matches `light-bolt11-decoder` on every BOLT-11 spec test vector, and
  rejects corrupted invoices via the bech32 checksum.
- **BIP-137 signature verification** — **157 checks** against `bitcoinjs-lib` /
  `bitcoinjs-message`: RIPEMD-160 spec vectors, 120 address derivations across all three address
  types, signing and verification compressed and uncompressed, and rejection of tampered messages,
  wrong addresses, 60 mutated signatures and malformed input.

Signature validation of *invoices* is deliberately out of scope: the invoice arrives from your own
wallet provider over TLS, and the page independently checks the amount and, on the manual path,
that the preimage hashes to the payment hash.

---

## Deploying

Any static host — GitHub Pages, Cloudflare Pages, Netlify, Deno Deploy, S3, plain nginx. Upload
`index.html`, `config.json`, and (if used) `inventory.json`, `config_hash.txt`, `config_hash.sig`.
`serve.mjs`, the scripts, and this README are not needed in production.

Serve over **HTTPS**: `crypto.subtle` — used for preimage checks and attestation — is unavailable
on plain HTTP, and wallet providers refuse mixed-content requests.

## Notes

- All rendering builds DOM nodes rather than interpolating HTML strings, so product and config
  text cannot inject markup.
- Uploaded images are resized (800px products, 128px icon) and embedded as data URLs. Convenient,
  but it inflates `config.json` — host images as files and use URLs once you have more than a few.
- Exchange rate basis is configurable: `index` is the neutral market price; `bull` is Bull
  Bitcoin's own quote, which includes their spread, so what you net after selling the sats is
  closer to the sticker price.
- The buyer's cart, order history, and any config draft never leave their browser.
