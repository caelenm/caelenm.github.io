# QR SneakerNet

A single self-contained HTML file that moves a file (or a snippet of text) across an air gap using nothing but a sequence of QR codes and a camera. No server, no network call, no install — open `index.html` in any modern browser and it works entirely offline.

**Live version:** https://caelenca.github.io/qr/

## What it does

One device ("send") displays a file as a rolling sequence of QR codes. A second device ("receive") photographs or scans them, in any order, and reassembles the original bytes — verified bit-exact against a checksum. There is no pairing, no Bluetooth, no Wi-Fi — the only channel between the two devices is a camera pointed at a screen (or a person copy-pasting scanned text).

The whole tool — UI, QR encoder, QR camera decoder, a compressor (deflate + Brotli, both compiled to WebAssembly/JS and inlined), and a PDF rasterizer (pdf.js, also inlined) — lives in one `.html` file with no external requests, so it can be copied onto a USB stick, emailed, or kept on an air-gapped machine indefinitely.

## How a transfer works

**Send side**

1. Pick a file (or type/paste text) into the Send tab.
2. The file is packed into a small custom container: `version | codec | filename | CRC32 | size | body`. Every payload is tried through *stored*, *deflate*, and *Brotli*, and whichever comes out smallest is kept — so compression is opportunistic and always lossless. Already-compressed formats (JPEG, ZIP, PDF, MP4, …) skip straight to *stored* rather than wasting time on a compressor that won't help.
3. Two optional, explicitly opt-in lossy steps can shrink the payload further before it's chunked: image re-encoding (recompress to WebP/JPEG at a target size, with optional downsampling) and PDF flattening (rasterize each page with pdf.js and rebuild a much smaller PDF, with an Otsu-threshold black-and-white mode for scans). Both report exactly what changed, and PDFs that would grow from flattening are left untouched automatically.
4. The compressed container is base44-encoded — 2 bytes → 3 characters, using an alphabet that stays inside the QR "alphanumeric" mode's 45-character set — then sliced into chunks sized to fit the chosen QR code capacity.
5. Each chunk becomes one QR code carrying `QZ1:<4-char set ID>:<index>:<total>:<payload>`. Because every code is self-describing, codes can be scanned in **any order**, duplicates are ignored, and a receiver can walk in mid-sequence.
6. The sender screen cycles through codes manually (Next/Back, arrow keys, spacebar) or auto-plays on a loop at a configurable rate so a phone camera can just sit and watch; a thumbnail rail shows which codes have already gone by.

**Receive side**

1. The receiving device either scans with its camera (`BarcodeDetector` where available, falling back to a bundled `jsQR` software decoder, with logic to detect when the "native" decoder is silently non-functional and swap to software) or has codes pasted in as text.
2. Codes are parsed by regex, keyed by set ID, and accumulated into a map of `index → payload` until every index from `1..total` is present.
3. Once complete, the chunks are joined, base44-decoded, decompressed, and checked against the CRC32 and size stored in the header. Only then is the result offered as a download (or shown as text, with inline preview for text/JSON/image types).
4. **Optical back-channel:** if frames are still missing after a full loop, the receiver can display its own QR code (`QZM:...`) listing exactly which indices it's missing — as a bitmap, not a list, so it stays small regardless of how scattered the gaps are. The sender scans that code with a front-facing camera ("Send Remaining") and narrows its loop to just those frames, then resumes broadcasting everything once they're filled in.
5. Scanning an ordinary QR code that isn't part of a SneakerNet transfer is also handled gracefully — it's just shown as plain text with a copy button and, if it looks like a URL, an "Open link" button.

## Tuning the codes

Two settings trade code size against scan reliability:

- **Preset** — the QR *version* (module grid size), from "Forgiving" (small, low-density, likely to scan on the first try) up to "Maximum" (177×177 modules — needs a big, sharp screen and a good camera, but drastically cuts the number of codes for a large file).
- **Error correction** — L (7% redundancy, max capacity) through H (30%, most tolerant of a dirty lens, glare, or a partial miss).

Both feed a binary search (`maxChars`) that determines exactly how many characters of a given error-correction level fit in a given QR version, so the chunking always uses the code's full capacity.

## Design choices worth knowing about

- **No network, ever.** The page's content-security policy blocks outbound requests entirely — this is a deliberate air-gap tool, not just an offline-capable one.
- **Bit-exact by construction.** Every optional transformation (compression, image re-encoding, PDF flattening) either round-trips exactly or is skipped; the receiver's CRC32 check is the final word.
- **Self-numbering chunks over strict ordering.** Nothing about the protocol assumes codes arrive in sequence, are shown once, or are all scanned in one sitting — which is what makes the missing-frames back-channel (and, as discussed below, a printed/paper version) possible without extra protocol changes.
- **Text has a fast path.** A short text snippet that fits in a single code is sent as the raw text itself — no framing, no base44 — so it reads on literally any QR scanner, not just this page.

## File layout

It's one HTML file. Structurally, inside it:

- Inlined libraries: `pdf.js` + its worker, a Brotli WASM build, `fflate` (deflate/zip), a `qrcodegen` QR encoder, and `jsQR` as a software QR decoder fallback.
- App logic (~1,500 lines of hand-written JS): container packing/unpacking, base44 codec, CRC32, QR chunking and playback, camera scanning with native/software decoder arbitration, the missing-frames back-channel, and a minimal hand-rolled PDF writer used only by the PDF-flattening feature.
- Markup and CSS for the two-tab (Send/Receive) interface.

There is no build step and no dependency manager — the libraries are inlined by hand into the shipped file.
