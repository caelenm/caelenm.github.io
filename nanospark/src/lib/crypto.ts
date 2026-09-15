/**
 * Seed encryption at rest (§3.2).
 *
 *   passphrase --Argon2id--> 32-byte key --AES-256-GCM--> sealed mnemonic
 *
 * Argon2id rather than PBKDF2 because it is memory-hard: an attacker who images
 * the device cannot trade memory for parallelism on a GPU. The pure-JS build
 * from @noble/hashes is used deliberately — adding a second WASM blob next to
 * the SDK's FROST signer would complicate the CSP for no security gain.
 *
 * The derived key never leaves memory and is zeroed on lock (see session.ts).
 */
import { argon2idAsync } from "@noble/hashes/argon2.js";

export const KDF_PARAMS = {
  name: "argon2id" as const,
  /** 64 MiB. High enough to hurt GPU attacks, low enough for a phone. */
  m: 65536,
  t: 3,
  p: 1,
  dkLen: 32,
};

/** Version tag so a future parameter change can be migrated rather than guessed. */
export const VAULT_VERSION = 1;

export interface SealedBlob {
  iv: Uint8Array;
  ct: Uint8Array;
}

export interface Vault extends SealedBlob {
  v: number;
  kdf: typeof KDF_PARAMS & { salt: Uint8Array };
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Best-effort zeroing. Not a guarantee under a GC'd runtime, but not nothing. */
export function wipe(...arrays: (Uint8Array | undefined | null)[]): void {
  for (const a of arrays) if (a) a.fill(0);
}

export async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  onProgress?: (p: number) => void,
): Promise<CryptoKey> {
  const pw = new TextEncoder().encode(passphrase.normalize("NFKC"));
  try {
    const raw = await argon2idAsync(pw, salt, {
      ...KDF_PARAMS,
      // Yield to the event loop so the unlock spinner actually animates.
      asyncTick: 16,
      onProgress,
    });
    try {
      return await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]);
    } finally {
      wipe(raw);
    }
  } finally {
    wipe(pw);
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
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt, onProgress);
  const { iv, ct } = await sealString(key, mnemonic);
  return { vault: { v: VAULT_VERSION, kdf: { ...KDF_PARAMS, salt }, iv, ct }, key };
}

export async function openVault(
  vault: Vault,
  passphrase: string,
  onProgress?: (p: number) => void,
): Promise<{ mnemonic: string; key: CryptoKey } | null> {
  if (vault.v !== VAULT_VERSION) return null;
  const key = await deriveKey(passphrase, vault.kdf.salt, onProgress);
  const mnemonic = await unsealString(key, vault);
  if (!mnemonic) return null;
  return { mnemonic, key };
}
