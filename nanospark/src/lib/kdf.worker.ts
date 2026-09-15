/**
 * Argon2id derivation, off the main thread.
 *
 * Two implementations, in order of preference:
 *
 *   hash-wasm   — compiled Argon2, ~10x faster than the pure-JS build at the
 *                 same parameters. This is what makes unlocking usable on a
 *                 phone: 64 MiB / t=3 costs a few hundred milliseconds here and
 *                 several seconds in JS.
 *   @noble/hashes — pure JS, used only if the WASM module fails to load.
 *
 * Both produce byte-identical output for identical parameters (there is a test
 * asserting exactly that), so which one ran is invisible to the vault format.
 * Nothing here is allowed to change the parameters it is handed — a KDF that
 * silently derives with different costs than the vault records is a wallet that
 * cannot be opened again.
 */
import { argon2id as nobleArgon2id } from "@noble/hashes/argon2.js";

export interface KdfRequest {
  /** UTF-8 bytes of the NFKC-normalised passphrase. */
  pw: Uint8Array;
  salt: Uint8Array;
  /** Memory cost in KiB. */
  m: number;
  /** Time cost (passes). */
  t: number;
  /** Parallelism. */
  p: number;
  dkLen: number;
}

export type KdfResponse =
  | { type: "progress"; value: number }
  | { type: "done"; raw: Uint8Array; backend: "wasm" | "js" }
  | { type: "error"; message: string };

async function deriveWithWasm(req: KdfRequest): Promise<Uint8Array> {
  const { argon2id } = await import("hash-wasm");
  return (await argon2id({
    password: req.pw,
    salt: req.salt,
    parallelism: req.p,
    iterations: req.t,
    memorySize: req.m,
    hashLength: req.dkLen,
    outputType: "binary",
  })) as Uint8Array;
}

function deriveWithJs(req: KdfRequest, onProgress: (v: number) => void): Uint8Array {
  return nobleArgon2id(req.pw, req.salt, {
    m: req.m,
    t: req.t,
    p: req.p,
    dkLen: req.dkLen,
    onProgress,
  });
}

self.onmessage = async (e: MessageEvent<KdfRequest>) => {
  const req = e.data;
  const post = (msg: KdfResponse, transfer?: Transferable[]) =>
    (self as unknown as Worker).postMessage(msg, transfer ?? []);

  try {
    let raw: Uint8Array;
    let backend: "wasm" | "js";
    try {
      raw = await deriveWithWasm(req);
      backend = "wasm";
    } catch {
      // The pure-JS path is slow enough that the UI needs to hear about it.
      raw = deriveWithJs(req, (value) => post({ type: "progress", value }));
      backend = "js";
    }
    // Copy out, then wipe the worker's own view of the secret material.
    const out = new Uint8Array(raw);
    raw.fill(0);
    req.pw.fill(0);
    post({ type: "done", raw: out, backend }, [out.buffer]);
  } catch (err) {
    req.pw.fill(0);
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
