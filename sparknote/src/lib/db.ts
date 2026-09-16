/**
 * IndexedDB persistence.
 *
 * Everything in here is a cache or a convenience (§3.1). Losing this database
 * costs history, contacts and settings; it never costs funds, because the
 * mnemonic alone reconstructs the wallet from the operators. Nothing here is
 * load-bearing for recovery, and no code path may treat it as authoritative
 * over the SDK.
 *
 * Two stores:
 *   meta   — small, plaintext, readable before unlock (settings, flags, vault)
 *   cache  — encrypted at rest, readable only once unlocked
 */
import type { SealedBlob, Vault } from "./crypto";
import { sealString, unsealString } from "./crypto";

const DB_NAME = "sparknote";
/**
 * Databases from the app's previous names, newest first. The first one found
 * holding a wallet is moved across once and then deleted.
 *
 * Renaming the app must never cost anyone their wallet, so every old name stays
 * listed here — a wallet last opened two names ago is still found. IndexedDB is
 * scoped to the origin rather than the path, so moving the app to a different
 * folder on the same site does not affect any of this.
 */
const LEGACY_DB_NAMES = ["nanospark", "sparklite"] as const;
const DB_VERSION = 1;
const META = "meta";
const CACHE = "cache";

export type NetworkName = "MAINNET" | "REGTEST";

/**
 * How the SDK arranges leaves.
 *
 * payments — the SDK default: a spread of denominations, so most sends need no
 *            swap first. Unilateral exit is expensive, because there are many
 *            small leaves and many of them are below dust.
 * exit     — the fewest, largest leaves the balance allows. The cheapest escape
 *            hatch and the least dust, at the cost of a swap before some sends.
 */
export type LeafLayout = "payments" | "exit";

/**
 * Stable balance.
 *
 * off      — everything is bitcoin.
 * whole    — the entire balance is held as USDB; incoming payments convert on
 *            arrival and sends convert back just in time.
 * separate — bitcoin and USDB are held side by side and moved between by hand.
 */
export type StableMode = "off" | "whole" | "separate";

export interface Settings {
  network: NetworkName;
  leafLayout: LeafLayout;
  stableMode: StableMode;
  /**
   * Claim confirmed on-chain deposits without asking, while the SSP's fee is at
   * or below `autoClaimMaxFeeSats`.
   *
   * Off by default: claiming spends the user's money on a fee, so it is their
   * decision. It is offered at all because bitcoin sitting at the static
   * deposit address is *not* recoverable from the recovery phrase alone — that
   * address is a P2TR of the user's key combined with the operators', so
   * claiming (or refunding) needs them either way. Leaving a deposit unclaimed
   * is therefore not the safe default it looks like.
   */
  autoClaimDeposits: boolean;
  /** Fee ceiling for auto-claim, in sats. Above this, the deposit waits for a person. */
  autoClaimMaxFeeSats: number;
}

export const DEFAULT_SETTINGS: Settings = {
  network: "MAINNET",
  leafLayout: "payments",
  stableMode: "off",
  autoClaimDeposits: false,
  autoClaimMaxFeeSats: 500,
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openNamed(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(CACHE)) db.createObjectStore(CACHE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    req.onblocked = () => reject(new Error("indexedDB blocked by another tab"));
  });
}

/**
 * Opens the legacy database only if it already exists. Opening a database that
 * does not exist would create it, so the upgrade that signals "new" is aborted,
 * which discards it again.
 */
function openLegacyIfPresent(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(name);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = (e) => {
      if (e.oldVersion === 0) req.transaction?.abort();
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function readAll(db: IDBDatabase, store: string): Promise<{ key: IDBValidKey; value: unknown }[]> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, "readonly");
    const s = t.objectStore(store);
    const keysReq = s.getAllKeys();
    const valuesReq = s.getAll();
    t.oncomplete = () => resolve(keysReq.result.map((key, i) => ({ key, value: valuesReq.result[i] })));
    t.onerror = () => reject(t.error ?? new Error("legacy read failed"));
  });
}

/**
 * One-time move from the database the app used under its previous name.
 *
 * Runs only when the new database holds no wallet. Everything is copied in one
 * transaction, and the old database is deleted only after that transaction
 * commits — a failure part-way leaves the old copy untouched for the next load.
 */
async function migrateLegacy(db: IDBDatabase): Promise<void> {
  const hasVault = await new Promise<boolean>((resolve) => {
    const t = db.transaction(META, "readonly");
    const r = t.objectStore(META).get("vault");
    r.onsuccess = () => resolve(r.result !== undefined);
    r.onerror = () => resolve(true); // unreadable: do not risk overwriting
  });
  if (hasVault) return;

  // Oldest names last: the first database that actually holds a wallet wins.
  for (const name of LEGACY_DB_NAMES) {
    const legacy = await openLegacyIfPresent(name);
    if (!legacy) continue;
    if (await moveFrom(db, legacy, name)) return;
  }
}

/** Copies one legacy database across. Returns true when a wallet was moved. */
async function moveFrom(db: IDBDatabase, legacy: IDBDatabase, name: string): Promise<boolean> {
  try {
    if (!legacy.objectStoreNames.contains(META) || !legacy.objectStoreNames.contains(CACHE)) return false;
    const [meta, cache] = await Promise.all([readAll(legacy, META), readAll(legacy, CACHE)]);
    if (!meta.some((e) => e.key === "vault")) return false;
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction([META, CACHE], "readwrite");
      for (const e of meta) t.objectStore(META).put(e.value, e.key);
      for (const e of cache) t.objectStore(CACHE).put(e.value, e.key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error("migration write failed"));
      t.onabort = () => reject(t.error ?? new Error("migration aborted"));
    });
  } catch {
    // A part-way failure leaves the old database untouched for the next load.
    return false;
  } finally {
    legacy.close();
  }
  // Only after the transaction above committed.
  indexedDB.deleteDatabase(name);
  return true;
}

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = openNamed(DB_NAME).then(async (db) => {
    await migrateLegacy(db).catch(() => {});
    return db;
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
      }),
  );
}

const get = <T>(store: string, key: string) => tx<T | undefined>(store, "readonly", (s) => s.get(key));
const put = (store: string, key: string, value: unknown) =>
  tx(store, "readwrite", (s) => s.put(value, key));
const del = (store: string, key: string) => tx(store, "readwrite", (s) => s.delete(key));

/* ---------------------------------------------------------------- */
/* Vault                                                             */
/* ---------------------------------------------------------------- */

export const loadVault = () => get<Vault>(META, "vault");
export const saveVault = (v: Vault) => put(META, "vault", v);

export async function hasWallet(): Promise<boolean> {
  try {
    return (await loadVault()) !== undefined;
  } catch {
    // A blocked or unavailable IndexedDB is not a wallet; the UI will warn
    // separately via the storage checks.
    return false;
  }
}

/* ---------------------------------------------------------------- */
/* Flags and settings — plaintext, needed before unlock              */
/* ---------------------------------------------------------------- */

export const loadBackupVerified = async () => (await get<boolean>(META, "backupVerified")) === true;
export const saveBackupVerified = (v: boolean) => put(META, "backupVerified", v);

/** Set when the user explicitly chose "back up later (unsafe)" (§3.3.6). */
export const loadBackupDeferred = async () => (await get<boolean>(META, "backupDeferred")) === true;
export const saveBackupDeferred = (v: boolean) => put(META, "backupDeferred", v);

/**
 * Set when the user explicitly turns privacy mode off. Without this the app
 * would helpfully re-enable it on the next unlock and override their choice.
 */
export const loadPrivacyOptOut = async () => (await get<boolean>(META, "privacyOptOut")) === true;
export const savePrivacyOptOut = (v: boolean) => put(META, "privacyOptOut", v);

export async function loadSettings(): Promise<Settings> {
  const s = await get<Partial<Settings>>(META, "settings");
  return { ...DEFAULT_SETTINGS, ...(s ?? {}) };
}
export const saveSettings = (s: Settings) => put(META, "settings", s);

/* ---------------------------------------------------------------- */
/* Sealed JSON — everything below is encrypted with the vault key    */
/* ---------------------------------------------------------------- */

async function saveSealed(key: CryptoKey, name: string, value: unknown): Promise<void> {
  await put(CACHE, name, await sealString(key, JSON.stringify(value)));
}

async function loadSealed<T>(key: CryptoKey, name: string): Promise<T | null> {
  const blob = await get<SealedBlob>(CACHE, name);
  if (!blob) return null;
  const json = await unsealString(key, blob);
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- */
/* Activity cache                                                    */
/* ---------------------------------------------------------------- */

export interface CachedActivity {
  id: string;
  direction: "in" | "out";
  amountSats: number;
  memo?: string;
  status: string;
  settled: boolean;
  /** Epoch millis. */
  time: number;
  kind: "lightning" | "spark" | "onchain" | "unknown";
  /* Detail-view fields. All optional: an older cache entry simply shows less. */
  counterparty?: string;
  updatedTime?: number;
  expiryTime?: number;
  transferType?: string;
  leafCount?: number;
}

/**
 * The activity list is financial metadata, so it is sealed with the same key as
 * the seed rather than left in the clear. It is still only a cache: the SDK is
 * re-queried on every unlock and its answer wins.
 */
export const saveActivityCache = (key: CryptoKey, items: CachedActivity[]) => saveSealed(key, "activity", items);

export async function loadActivityCache(key: CryptoKey): Promise<CachedActivity[]> {
  const parsed = await loadSealed<unknown>(key, "activity");
  return Array.isArray(parsed) ? (parsed as CachedActivity[]) : [];
}

export const clearActivityCache = () => del(CACHE, "activity");

/* ---------------------------------------------------------------- */
/* Contacts                                                          */
/* ---------------------------------------------------------------- */

export type ContactKind = "spark" | "lightning-address" | "lnurl" | "onchain";

export interface Contact {
  id: string;
  name: string;
  /** Exactly what gets pasted back into Send. */
  address: string;
  kind: ContactKind;
  /** Spark and Bitcoin addresses belong to one network; the list is filtered by it. */
  network: NetworkName;
  addedAt: number;
}

/**
 * Who you pay is some of the most sensitive metadata a wallet holds, so the
 * address book is sealed with the vault key like everything else here, and is
 * only readable once the wallet is unlocked.
 */
export const saveContacts = (key: CryptoKey, contacts: Contact[]) => saveSealed(key, "contacts", contacts);

export async function loadContacts(key: CryptoKey): Promise<Contact[]> {
  const parsed = await loadSealed<unknown>(key, "contacts");
  return Array.isArray(parsed) ? (parsed as Contact[]) : [];
}

/* ---------------------------------------------------------------- */
/* Unilateral exit — the in-browser engine's job                     */
/* ---------------------------------------------------------------- */

/*
 * A unilateral exit runs for a day or more on regtest and far longer on
 * mainnet, so its progress has to survive reloads. It names the destination
 * address and every amount involved, which is exactly the kind of metadata the
 * activity cache is sealed for — so it is sealed too.
 *
 * Losing it is recoverable rather than fatal: every transaction it tracks is on
 * the Bitcoin chain, and a fresh capture from the operators rebuilds the plan.
 * But that needs the operators to be online, which is the one assumption a
 * unilateral exit exists to avoid. Hence changePassphrase re-seals it rather
 * than discarding it like the activity cache.
 */
const exitJobKey = (network: NetworkName) => `exitJob:${network}`;

export const saveExitJob = (key: CryptoKey, network: NetworkName, job: unknown) => saveSealed(key, exitJobKey(network), job);
export const loadExitJob = <T>(key: CryptoKey, network: NetworkName) => loadSealed<T>(key, exitJobKey(network));
export const clearExitJob = (network: NetworkName) => del(CACHE, exitJobKey(network));

/* ---------------------------------------------------------------- */
/* Unilateral exit — captured leaves for the exit bundle             */
/* ---------------------------------------------------------------- */

/*
 * The pre-signed transactions an exit bundle is built from, captured while the
 * operators were reachable. Kept so a bundle can be rebuilt later — at a higher
 * fee rate, or after part of it confirmed — without the operators, which is
 * precisely when a rebuild is most likely to be needed.
 */
const exitCaptureKey = (network: NetworkName) => `exitCapture:${network}`;

export const saveExitCapture = (key: CryptoKey, network: NetworkName, capture: unknown) =>
  saveSealed(key, exitCaptureKey(network), capture);
export const loadExitCapture = <T>(key: CryptoKey, network: NetworkName) => loadSealed<T>(key, exitCaptureKey(network));
export const clearExitCapture = (network: NetworkName) => del(CACHE, exitCaptureKey(network));

/**
 * Every sealed record, so changePassphrase can re-seal the ones worth keeping
 * rather than silently losing them.
 */
export const SEALED_TO_KEEP = (network: NetworkName) => ["contacts", exitJobKey(network), exitCaptureKey(network)];

export async function resealAll(oldKey: CryptoKey, newKey: CryptoKey): Promise<void> {
  const names = new Set<string>(["MAINNET", "REGTEST"].flatMap((n) => SEALED_TO_KEEP(n as NetworkName)));
  const values: { name: string; value: unknown }[] = [];
  for (const name of names) {
    const value = await loadSealed<unknown>(oldKey, name).catch(() => null);
    if (value !== null) values.push({ name, value });
  }
  for (const { name, value } of values) await saveSealed(newKey, name, value);
}

/* ---------------------------------------------------------------- */
/* Wipe                                                              */
/* ---------------------------------------------------------------- */

function deleteDb(name: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("delete failed"));
    // A second tab holding the database open should not hang the wipe forever.
    req.onblocked = () => resolve();
  });
}

/** Destroys the whole database. The mnemonic is the only way back (§4 Settings). */
export async function wipeEverything(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null);
    db?.close();
    dbPromise = null;
  }
  await deleteDb(DB_NAME);
  // A leftover database under ANY old name would be migrated back in on the
  // next load, resurrecting the wallet that was just wiped.
  for (const name of LEGACY_DB_NAMES) await deleteDb(name).catch(() => {});
}
