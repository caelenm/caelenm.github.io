/**
 * Storage durability checks (§3.6).
 *
 * Browser storage is hostile: Safari's ITP evicts, private windows discard on
 * close, and "clear cookies" takes the vault with it. None of that costs funds
 * if the phrase is written down — which is exactly why these checks feed a
 * warning banner rather than a blocking error.
 */

export type StorageHealth = {
  /** navigator.storage.persist() granted — data is exempt from routine eviction. */
  persistent: boolean;
  /** We asked and were refused, or the API does not exist. */
  persistenceAvailable: boolean;
  /** Best-effort private/incognito detection. */
  ephemeral: boolean;
  /** IndexedDB is usable at all. Without it there is nowhere to keep a wallet. */
  indexedDbUsable: boolean;
  quotaBytes?: number;
};

async function requestPersistence(): Promise<{ persistent: boolean; available: boolean }> {
  if (!navigator.storage?.persist || !navigator.storage?.persisted) {
    return { persistent: false, available: false };
  }
  try {
    if (await navigator.storage.persisted()) return { persistent: true, available: true };
    const granted = await navigator.storage.persist();
    return { persistent: granted, available: true };
  } catch {
    return { persistent: false, available: false };
  }
}

async function probeIndexedDb(): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const req = indexedDB.open("nanospark-probe");
      req.onsuccess = () => {
        req.result.close();
        indexedDB.deleteDatabase("nanospark-probe");
        done(true);
      };
      req.onerror = () => done(false);
      // Firefox private mode historically neither resolves nor rejects.
      setTimeout(() => done(false), 3000);
    } catch {
      done(false);
    }
  });
}

/**
 * Private-mode detection is heuristic by design — browsers actively work to
 * make it impossible, and we must not claim certainty we do not have. A tiny
 * quota is the most reliable remaining signal.
 */
async function probeEphemeral(): Promise<{ ephemeral: boolean; quotaBytes?: number }> {
  try {
    const est = await navigator.storage?.estimate?.();
    const quota = est?.quota;
    if (typeof quota === "number") {
      // Chrome's incognito quota is a fraction of disk and lands well under
      // 300MB on typical machines; normal profiles get gigabytes.
      return { ephemeral: quota < 300_000_000, quotaBytes: quota };
    }
  } catch {
    /* fall through */
  }
  return { ephemeral: false };
}

export async function checkStorage(): Promise<StorageHealth> {
  const [idb, persist, eph] = await Promise.all([
    probeIndexedDb(),
    requestPersistence(),
    probeEphemeral(),
  ]);
  return {
    indexedDbUsable: idb,
    persistent: persist.persistent,
    persistenceAvailable: persist.available,
    ephemeral: eph.ephemeral,
    quotaBytes: eph.quotaBytes,
  };
}
