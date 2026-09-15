# nanospark security audit

Full review of the wallet source, September 2026. Scope: everything under
`src/`, `public/frame-guard.js`, `index.html`'s CSP, the build configuration
and the dependency tree. Method: line-by-line reading of the security-relevant
modules, verification of claims against the Spark SDK's own types, targeted
tests written to confirm each finding, and a run of the built app in Chromium
under the production CSP.

Findings are rated by what an attacker gets, not by how clever the bug is.

---

## Summary

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | A 4-character PIN falls to offline brute force in minutes | **High** | Accepted by owner — documented below |
| 2 | Lightning sends reported as delivered without proof | **High** | Fixed |
| 3 | A KDF parameter change would have bricked every existing wallet | **High** | Fixed |
| 4 | SSRF: IPv6 private ranges reachable via LNURL | **Medium** | Fixed |
| 5 | SSRF tests passed whether or not the guard existed | **Medium** | Fixed |
| 6 | Invoice network never checked against the wallet's | **Medium** | Fixed |
| 7 | LNURL-returned invoices skipped the expiry check | **Low** | Fixed |
| 8 | No automatic lock, ever | **Medium** | By design — see below |
| 9 | `connect-src` ends in a bare `https:` | **Medium** | Accepted, unavoidable for LNURL |
| 10 | DNS rebinding cannot be defended in-browser | **Low** | Inherent |
| 11 | Cooperative exit relies on the SSP to reject a wrong-network address | **Low** | Open |
| 12 | Grid permutation has modulo bias; the comment claims otherwise | **Info** | Open |
| 13 | 7 MB single bundle, no integrity pinning | **Info** | Open |

---

## 1. A 4-character PIN falls to offline brute force in minutes — High

**Accepted by the owner as a deliberate trade.** Recorded here so the cost is
explicit rather than implied.

The minimum unlock passphrase was lowered from 8 characters to 4. The vault is
Argon2id (64 MiB, t=3) + AES-256-GCM, which is a strong construction — but it
is the *only* barrier, and it is applied to a secret with very little entropy.
An attacker who copies the browser profile (stolen laptop, backup, malware,
a shared machine) attacks the vault offline, where nothing in this app applies:
no lockout, no delay, no rate limit. The app's own login screen is irrelevant
to them.

Measured on this machine, one Argon2id guess at the shipped parameters costs
**359 ms** on a single core:

| Secret | Search space | 1 core | 16 cores |
|---|---|---|---|
| 4-digit numeric PIN | 10,000 | ~60 min | **~3.7 min** |
| 4-char lowercase | 456,976 | ~2 days | ~3 hours |
| 4-char alphanumeric | 14.8M | ~2 months | ~3.8 days |
| 8-char alphanumeric | 2.2×10¹⁴ | — | ~157,000 years |

A 4-digit PIN is not meaningfully protected. A 4-character *alphanumeric* one
is far better, and 8 characters is in a different universe.

Note that moving Argon2 to WASM did **not** weaken this. The attacker was never
running our pure-JS build; their cost was always ~359 ms/guess. The old 4.1 s
unlock was a handicap on the user only.

The UI now warns (without blocking) below 8 characters, and `crypto.ts`
documents the trade at `MIN_PASSPHRASE_LENGTH`.

**If this risk is ever revisited**, the effective mitigation is not a longer
Argon2 — it is removing the offline attack. Mix a high-entropy random "device
secret" into the KDF and store it separately (ideally non-extractable), so the
vault blob alone is not sufficient. Attempt throttling in the UI does **not**
help here; the attacker never touches the UI.

## 2. Lightning sends reported as delivered without proof — High (fixed)

`payLightningInvoice` returns a status and, on success, the payment preimage.
Both were discarded, and the send screen showed "Sent" unconditionally. A
payment still in flight, one that failed after dispatch, or one whose preimage
did not correspond to the invoice all rendered as delivered.

This is the failure mode that matters for a wallet: the user stops chasing a
payment the receiver never got.

Fixed by `src/lib/lightning.ts`. An invoice commits to `sha256(preimage)`, so a
preimage that hashes to the invoice's payment hash is the only cryptographic
proof of delivery — it cannot be produced by anyone who did not get paid. The
classifier therefore:

- treats a **verified preimage as proof**, outranking a lagging status;
- treats a **preimage that does not match the invoice as failure**, whatever the
  status claims (the dangerous case: `LIGHTNING_PAYMENT_SUCCEEDED` alongside a
  preimage for a different payment);
- takes the payment hash from the invoice being paid, never from the response,
  so the proof is not circular;
- treats every unrecognised or absent status as **in flight, never delivered**.

The UI now distinguishes "still settling" from "sent". Covered by
`src/lib/lightning.test.ts`.

## 3. A KDF parameter change would have bricked every existing wallet — High (fixed)

`Vault` recorded its own KDF parameters, but `deriveKey` ignored them and spread
the current module constants. Any future change to `m`, `t`, `p` or `dkLen`
would have made every existing vault underivable — surfacing to the user as
nothing more than *"That didn't work."*, indistinguishable from a wrong
passphrase, with the funds still encrypted on disk.

`changePassphrase` had the mirror-image bug: it wrote the *outgoing* vault's
parameters next to a key derived with the *current* ones, so the record and the
key disagreed from the moment it was written.

Fixed: derivation always honours the parameters stored in the vault, and a vault
written at other parameters is transparently re-sealed after it opens. Covered
by `src/lib/crypto.test.ts`.

## 4. SSRF: IPv6 private ranges reachable via LNURL — Medium (fixed)

`assertSafeUrl` blocked IPv4 private ranges and IPv6 loopback as the literal
string `[::1]`. It did not block:

- `[fd00::1]`, `[fc00::1]` — unique-local (`fc00::/7`)
- `[fe80::1]` — link-local
- `[::]` — unspecified
- `[::ffff:127.0.0.1]` — IPv4-mapped, and the important one: the URL parser
  re-renders it as `[::ffff:7f00:1]`, so no dotted-quad regex could ever match
  it

A hostile Lightning address or LNURL could therefore make the user's browser
issue requests to hosts on their local network. Fixed; all of the above are now
refused.

Alternate IPv4 spellings (`2130706433`, `0x7f000001`, `017700000001`) were
already safe — the WHATWG URL parser normalises them to dotted quads before the
check runs — and are now pinned down by tests so that stays true.

## 5. SSRF tests passed whether or not the guard existed — Medium (fixed)

The pre-existing SSRF tests asserted only that an `LnurlError` was thrown. An
*unreachable* host also raises `LnurlError` ("Could not reach the recipient's
server"), so every one of those tests passed with the private-address guard
deleted entirely. They were providing no protection against regression.

They now assert the refusal *reason*, which also proves no request was
attempted. Reverting finding 4 fails six of them; before this change it failed
none.

This is worth calling out beyond the specific bug: a test that passes for the
wrong reason is more dangerous than no test, because it is counted as coverage.

## 6. Invoice network never checked against the wallet's — Medium (fixed)

`bolt11.ts` decodes each invoice's network, and nothing ever compared it to
`settings.network`. A mainnet invoice could be carried through a regtest
wallet's confirm screen (and the reverse). The on-chain *unilateral* exit path
already refuses a cross-network destination, so the absence here was an
oversight rather than a decision.

Fixed in `prepareBolt11`, the single function every invoice passes through —
pasted, pasted-with-amount, or returned by an LNURL server.

## 7. LNURL-returned invoices skipped the expiry check — Low (fixed)

A pasted invoice was checked with `isExpired`; an invoice returned by an LNURL
server went straight to the confirm screen. Impact was limited (paying an
expired invoice fails; funds are not at risk), but it was an inconsistency in
the same code path. Fixed alongside finding 6.

## 8. No automatic lock, ever — Medium (by design)

`useIdleLock` is an intentional no-op, documented in the source: there is no
idle timer and no lock on tab close. The stated reasoning — frequent prompts
push users toward weaker passphrases — is sound in isolation.

It interacts badly with finding 1, though. The original argument traded auto-lock
away *in exchange for* longer passphrases; with a 4-character minimum, the
wallet now has neither. An unlocked tab left open is a spendable wallet for
anyone with physical access.

Worth reconsidering as a pair: if the PIN stays at 4, a generous idle lock
(15–30 minutes) costs little, since unlocking is now ~390 ms rather than 4 s.
The reasoning that made auto-lock expensive was partly the slow unlock, and that
is no longer true.

## 9. `connect-src` ends in a bare `https:` — Medium (accepted)

The CSP names each Spark origin explicitly and then appends `https:`. That
trailing entry permits connections to any HTTPS origin, which substantially
weakens what the rest of the list achieves.

It is not removable while LNURL sending is supported: paying a Lightning address
means contacting a host the *recipient* chooses, unknowable ahead of time. The
`index.html` comment already documents this and correctly notes that removing
`https:` disables LNURL while leaving every other feature working — a supported,
stricter configuration.

No change recommended, but users who never pay Lightning addresses can harden
this by deleting one token.

## 10. DNS rebinding cannot be defended in-browser — Low (inherent)

`assertSafeUrl` checks the *hostname*. A hostname that resolves to a private
address (`internal.attacker.test` → `127.0.0.1`) passes, because the page cannot
see the resolved IP — browsers do not expose it. This is a structural limit of
doing SSRF defence in a browser, not a flaw in the implementation. Private
Network Access restrictions in modern browsers mitigate it partially.

## 11. Cooperative exit relies on the SSP to reject a wrong-network address — Low

An on-chain withdrawal address is not validated against the wallet's network
locally; the flow depends on `quoteWithdrawal` failing server-side, surfacing as
"The SSP would not quote this withdrawal." The unilateral path does check
locally. Funds are not at risk, but the error is opaque where it could be exact.

## 12. Grid permutation has modulo bias — Info

`makeGridPermutation` comments "Fisher-Yates with rejection sampling", but the
implementation is `rand[i] % (i + 1)` — plain modulo, which is biased. The
comment describes something the code does not do.

Security impact is nil: the permutation only obfuscates which grid cell maps to
which symbol for display, and entropy is credited per distinct cell, not per
symbol value. The actual key material comes from `HMAC(key = getRandomValues(32),
msg = pool)`, so the pool cannot weaken the result even if fully attacker-chosen.
Worth correcting the comment or the code so the two agree.

## 13. 7 MB single bundle, no integrity pinning — Info

The build emits one ~7 MB JavaScript chunk. There is no subresource integrity
(not applicable for same-origin scripts) and no code splitting, so the whole
surface loads on every visit and a compromise of any dependency is a compromise
of the wallet. This is normal for the architecture and is called out only so the
dependency tree is understood as part of the trust base.

`hash-wasm`, added during this work, was chosen partly for this reason: zero
transitive dependencies, MIT, and it is loaded only inside the KDF worker.

---

## What is solid

These held up under review and deserve to be recorded, because they are the
parts most often gotten wrong:

- **No XSS sinks whatsoever.** No `dangerouslySetInnerHTML`, no `innerHTML`, no
  `eval`, no `new Function`, no `document.write`. Every external link carries
  `rel="noreferrer"`.
- **Key material handling.** The vault key and mnemonic live in memory only and
  are never written to `sessionStorage` to survive reloads — an explicit,
  documented refusal of a real convenience. Buffers are zeroed after use, and
  the passphrase is transferred into the KDF worker so the main thread's copy is
  detached rather than left for the GC.
- **Entropy.** `toMnemonic` is `HMAC(key = CSPRNG(32), msg = pool_digest)`. Even
  a fully attacker-controlled entropy pool cannot weaken the output, because the
  HMAC key is CSPRNG-derived. The `Math.random` call in the pool only ever adds
  to the message, never the key. The optional user-entropy grid is honest about
  crediting ~2 bits for a repeated cell versus 11 for a new one.
- **LNURL invoice amount checking.** The returned invoice is decoded locally and
  its amount compared to what was requested; open-amount invoices are refused
  outright. A payee server cannot inflate the amount.
- **Lightning address parsing.** Splits on exactly one `@`, rejects multi-`@`
  (`a@b@c.com` would otherwise contact `b`), and constrains the domain to label
  syntax so the string cannot carry a path, port or credentials.
- **Frame guard.** The page ships hidden via an inline style and is revealed only
  when it is provably top-level, correctly compensating for the fact that
  `frame-ancestors` cannot be delivered by `<meta>` and GitHub Pages cannot send
  headers. Verified in the browser: it reveals correctly and no CSP violations
  are raised.
- **Failure semantics.** `unseal` returns null for both a wrong passphrase and a
  corrupt blob, so the two are indistinguishable. Wrong unlock attempts do not
  wipe anything — a deliberate refusal to turn a typo into a disaster.
- **Deposit confirmations.** The confirmation count never overstates depth: an
  unreadable chain tip falls back to the shallowest value rather than assuming
  the deposit is claimable, and a reorged tip cannot produce a negative count.
  Now covered by tests.

## Recommended next steps

1. **Reconsider the 4-character minimum, or add a device secret** (finding 1).
   This is the one finding where the residual risk is high and quantified.
2. **Add an idle lock** (finding 8) — cheap now that unlocking is sub-second,
   and it partly compensates for finding 1.
3. Fix the permutation comment or the sampling (finding 12).
4. Add a local network check to the cooperative exit address (finding 11).

## Verification performed

- `npm test` — 9 test files, all passing, including the new
  `crypto.test.ts`, `lightning.test.ts` and `deposits.test.ts`.
- `npm run typecheck` — clean.
- `npm run build` — clean.
- Built output driven in Chromium: frame guard reveals the page, the app mounts,
  the 4-character rule is enforced in the UI, **zero CSP violations**, the KDF
  worker reports the `wasm` backend, and a vault round-trip succeeds in ~390 ms
  where the pure-JS path took ~4100 ms.
- Findings 4 and 5 verified by reverting the fix and confirming the tests fail.
