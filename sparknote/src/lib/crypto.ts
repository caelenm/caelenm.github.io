/**
 * Seed encryption at rest (§3.2).
 *
 *   passphrase --Argon2id--> 32-byte key --AES-256-GCM--> sealed mnemonic
 *
 * Argon2id rather than PBKDF2 because it is memory-hard: an attacker who images
 * the device cannot trade memory for parallelism on a GPU.
 *
 * The derivation runs in a worker (see kdf.worker.ts), which prefers a compiled
 * Argon2 and falls back to the pure-JS one. Both yield identical bytes for
 * identical parameters, so the backend is invisible to the vault format.
 *
 * The derived key never leaves memory and is zeroed on lock.
 */
import { argon2id as nobleArgon2id } from "@noble/hashes/argon2.js";
import type { KdfRequest, KdfResponse } from "./kdf.worker.ts";

/** Cost parameters. Changing these is a vault migration — see `vaultNeedsUpgrade`. */
export const KDF_PARAMS = {
  name: "argon2id" as const,
  /** 64 MiB. High enough to hurt GPU attacks, low enough for a phone. */
  m: 65536,
  t: 3,
  p: 1,
  dkLen: 32,
};

export type KdfParams = typeof KDF_PARAMS;
export type StoredKdf = KdfParams & { salt: Uint8Array };

/** Version tag so a future parameter change can be migrated rather than guessed. */
export const VAULT_VERSION = 1;

/**
 * Shortest accepted unlock passphrase.
 *
 * Four is a deliberate, informed trade of security for the convenience of a
 * PIN-length secret. Be clear about what it costs: a 4-digit numeric PIN is
 * 10,000 candidates, and an attacker holding a copy of the vault tries them
 * offline, where no lockout or delay in this app applies. The Argon2id cost
 * above is then the *only* thing standing between that copy and the seed, which
 * is why it is not reduced to make unlocking faster — the WASM backend buys the
 * speed instead. A longer passphrase remains materially safer, and the UI says
 * so at short lengths.
 */
export const MIN_PASSPHRASE_LENGTH = 4;

/** Below this, the UI warns without blocking. */
export const WEAK_PASSPHRASE_LENGTH = 8;

export interface SealedBlob {
  iv: Uint8Array;
  ct: Uint8Array;
}

export interface Vault extends SealedBlob {
  v: number;
  kdf: StoredKdf;
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Best-effort zeroing. Not a guarantee under a GC'd runtime, but not nothing. */
export function wipe(...arrays: (Uint8Array | undefined | null)[]): void {
  for (const a of arrays) if (a) a.fill(0);
}

/**
 * True when `vault` was sealed under different cost parameters than the ones
 * this build uses. The vault still opens — `deriveKey` always honours the
 * parameters recorded in the vault — but it should be re-sealed at the current
 * cost once the passphrase is known.
 */
export function vaultNeedsUpgrade(vault: Vault): boolean {
  const k = vault.kdf;
  return (
    vault.v !== VAULT_VERSION ||
    k.name !== KDF_PARAMS.name ||
    k.m !== KDF_PARAMS.m ||
    k.t !== KDF_PARAMS.t ||
    k.p !== KDF_PARAMS.p ||
    k.dkLen !== KDF_PARAMS.dkLen
  );
}

/** Runs Argon2id in a worker, falling back to this thread where there is none. */
function deriveRaw(
  pw: Uint8Array,
  kdf: StoredKdf,
  onProgress?: (p: number) => void,
): Promise<Uint8Array> {
  const req: KdfRequest = {
    pw,
    salt: kdf.salt,
    m: kdf.m,
    t: kdf.t,
    p: kdf.p,
    dkLen: kdf.dkLen,
  };

  // No worker (tests, and any browser that denies one): derive in place. This is
  // the slow pure-JS path, so it still reports progress.
  if (typeof Worker === "undefined") {
    return Promise.resolve(
      nobleArgon2id(req.pw, req.salt, {
        m: req.m,
        t: req.t,
        p: req.p,
        dkLen: req.dkLen,
        ...(onProgress ? { onProgress } : {}),
      }),
    );
  }

  return new Promise<Uint8Array>((resolve, reject) => {
    const worker = new Worker(new URL("./kdf.worker.ts", import.meta.url), { type: "module" });
    const finish = (fn: () => void) => {
      worker.terminate();
      fn();
    };
    worker.onmessage = (e: MessageEvent<KdfResponse>) => {
      const msg = e.data;
      if (msg.type === "progress") onProgress?.(msg.value);
      else if (msg.type === "done") finish(() => resolve(msg.raw));
      else finish(() => reject(new Error(msg.message)));
    };
    worker.onerror = () => finish(() => reject(new Error("key derivation worker failed")));
    // `pw` is transferred, so this thread's copy is detached rather than left
    // lying in memory for the GC to get to eventually.
    worker.postMessage(req, [pw.buffer]);
  });
}

/**
 * Derives the vault key. `kdf` carries the parameters *and* the salt, and both
 * come from the vault being opened — never from the constants above — so a
 * vault sealed by an older build still opens under this one.
 */
export async function deriveKey(
  passphrase: string,
  kdf: StoredKdf,
  onProgress?: (p: number) => void,
): Promise<CryptoKey> {
  const pw = new TextEncoder().encode(passphrase.normalize("NFKC"));
  let raw: Uint8Array | undefined;
  try {
    raw = await deriveRaw(pw, kdf, onProgress);
    return await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  } finally {
    wipe(raw);
    // A transferred buffer is already detached; wiping it would throw.
    if (pw.byteLength > 0) wipe(pw);
  }
}

export async function seal(key: CryptoKey, plaintext: Uint8Array): Promise<SealedBlob> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext as BufferSource),
  );
  return { iv, ct };
}

/** Returns null on any failure — a wrong passphrase and a corrupt blob look identical (§3.6). */
export async function unseal(key: CryptoKey, blob: SealedBlob): Promise<Uint8Array | null> {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blob.iv as BufferSource },
      key,
      blob.ct as BufferSource,
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

export async function sealString(key: CryptoKey, s: string): Promise<SealedBlob> {
  const bytes = new TextEncoder().encode(s);
  try {
    return await seal(key, bytes);
  } finally {
    wipe(bytes);
  }
}

export async function unsealString(key: CryptoKey, blob: SealedBlob): Promise<string | null> {
  const bytes = await unseal(key, blob);
  if (!bytes) return null;
  try {
    return new TextDecoder().decode(bytes);
  } finally {
    wipe(bytes);
  }
}

/** Builds a fresh vault around a mnemonic. Salt and IV are per-wallet and random. */
export async function createVault(
  passphrase: string,
  mnemonic: string,
  onProgress?: (p: number) => void,
): Promise<{ vault: Vault; key: CryptoKey }> {
  const kdf: StoredKdf = { ...KDF_PARAMS, salt: randomBytes(16) };
  const key = await deriveKey(passphrase, kdf, onProgress);
  const { iv, ct } = await sealString(key, mnemonic);
  return { vault: { v: VAULT_VERSION, kdf, iv, ct }, key };
}

export async function openVault(
  vault: Vault,
  passphrase: string,
  onProgress?: (p: number) => void,
): Promise<{ mnemonic: string; key: CryptoKey } | null> {
  // Deliberately not gated on `vault.v === VAULT_VERSION`: a vault written by a
  // different version is upgraded after it opens, not refused. Refusing here is
  // indistinguishable to the user from a wrong passphrase.
  const key = await deriveKey(passphrase, vault.kdf, onProgress);
  const mnemonic = await unsealString(key, vault);
  if (!mnemonic) return null;
  return { mnemonic, key };
}
