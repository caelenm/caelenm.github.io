/**
 * Vault encryption: the derivation honours what the vault recorded, and the two
 * Argon2 backends are interchangeable.
 *
 * Run with: node --experimental-strip-types src/lib/crypto.test.ts
 *
 * There is no Worker in Node, so crypto.ts takes its in-thread pure-JS path
 * here. Parameters are deliberately tiny: these assert plumbing, not cost.
 */
import { argon2id as nobleArgon2id } from "@noble/hashes/argon2.js";
import { argon2id as wasmArgon2id } from "hash-wasm";
import {
  KDF_PARAMS,
  VAULT_VERSION,
  createVault,
  deriveKey,
  openVault,
  sealString,
  unsealString,
  vaultNeedsUpgrade,
  type StoredKdf,
  type Vault,
} from "./crypto.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${actual} want ${expected}`}`);
}

const MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";
/** Cheap on purpose — the real cost is asserted by the parameters, not by waiting. */
const CHEAP = { name: "argon2id" as const, m: 256, t: 1, p: 1, dkLen: 32 };
const salt = (b: number) => new Uint8Array(16).fill(b);

/* --- the two backends must agree, or the worker's fallback changes the key -- */
{
  for (const p of [
    { m: 256, t: 1, p: 1, dkLen: 32 },
    { m: 1024, t: 2, p: 1, dkLen: 32 },
  ]) {
    const pw = new TextEncoder().encode("pässwörd");
    const js = nobleArgon2id(pw, salt(1), p);
    const wasm = (await wasmArgon2id({
      password: pw,
      salt: salt(1),
      parallelism: p.p,
      iterations: p.t,
      memorySize: p.m,
      hashLength: p.dkLen,
      outputType: "binary",
    })) as Uint8Array;
    check(
      `wasm and pure-JS argon2id agree at m=${p.m} t=${p.t}`,
      Buffer.from(wasm).toString("hex"),
      Buffer.from(js).toString("hex"),
    );
  }
}

/* --- a vault opens under the parameters it stored, not the current ones ----- */
{
  // A vault written by a hypothetical older build, at costs this build no longer uses.
  const kdf: StoredKdf = { ...CHEAP, salt: salt(9) };
  const key = await deriveKey("open sesame", kdf);
  const { iv, ct } = await sealString(key, MNEMONIC);
  const legacy: Vault = { v: VAULT_VERSION, kdf, iv, ct };

  check("the stored parameters differ from this build's", kdf.m === KDF_PARAMS.m, false);

  const opened = await openVault(legacy, "open sesame");
  check("a vault sealed at other parameters still opens", opened?.mnemonic, MNEMONIC);
  check("and it is flagged for upgrade", vaultNeedsUpgrade(legacy), true);

  const wrong = await openVault(legacy, "open sesamf");
  check("a wrong passphrase returns null", wrong, null);
}

/* --- round trip at the real parameters ------------------------------------- */
{
  const { vault, key } = await createVault("hunter2", MNEMONIC);
  check("a fresh vault records this build's cost", vault.kdf.m, KDF_PARAMS.m);
  check("a fresh vault needs no upgrade", vaultNeedsUpgrade(vault), false);
  check("its salt is 16 bytes", vault.kdf.salt.length, 16);
  check("its iv is 12 bytes", vault.iv.length, 12);

  const opened = await openVault(vault, "hunter2");
  check("it reopens", opened?.mnemonic, MNEMONIC);
  check("the sealed mnemonic is not stored in the clear", Buffer.from(vault.ct).includes("legal"), false);

  // The key handed back at creation must be the same key the vault yields.
  const blob = await sealString(key, "contact list");
  check("the creation key and the opened key agree", await unsealString(opened!.key, blob), "contact list");
}

/* --- upgrade detection ----------------------------------------------------- */
{
  const base = { ...KDF_PARAMS, salt: salt(3) };
  const mk = (over: Partial<StoredKdf>): Vault => ({
    v: VAULT_VERSION,
    kdf: { ...base, ...over },
    iv: new Uint8Array(12),
    ct: new Uint8Array(0),
  });
  check("same parameters: no upgrade", vaultNeedsUpgrade(mk({})), false);
  check("a different memory cost needs one", vaultNeedsUpgrade(mk({ m: 32768 })), true);
  check("a different time cost needs one", vaultNeedsUpgrade(mk({ t: 2 })), true);
  check("a different key length needs one", vaultNeedsUpgrade(mk({ dkLen: 16 })), true);
  check("an older vault version needs one", vaultNeedsUpgrade({ ...mk({}), v: 0 }), true);
  // Salt differs per wallet and is not a cost parameter.
  check("a different salt alone does not", vaultNeedsUpgrade(mk({ salt: salt(4) })), false);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
