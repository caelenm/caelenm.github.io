/**
 * The whole application state machine.
 *
 * Ordering rule that governs this file: the SDK is authoritative, the local
 * cache never is (§3.6, "mid-payment interruption"). Anything read from
 * IndexedDB is shown as a placeholder and replaced the moment the operators
 * answer.
 */
import { create } from "zustand";
import {
  SparkWallet,
  SparkWalletEvent,
  buildUnilateralExitChain,
  constructFeeBumpTx,
} from "@buildonspark/spark-sdk";
import * as db from "../lib/db";
import type { CachedActivity, Contact, ContactKind, LeafLayout, NetworkName, Settings, StableMode } from "../lib/db";
import {
  createVault,
  openVault,
  deriveKey,
  sealString,
  vaultNeedsUpgrade,
  KDF_PARAMS,
  VAULT_VERSION,
} from "../lib/crypto";
import { checkStorage, type StorageHealth } from "../lib/storage";
import { readableError } from "../lib/format";
import {
  DEFAULT_SLIPPAGE_BPS,
  convertToBitcoin,
  convertToStable,
  planStableSweep,
  sweepStableToBitcoin,
  type SweepPlan,
  executeRebalance,
  formatUsd,
  payFromStable,
  planRebalance,
  stableSupported,
  withSlippage,
  type ConvertResult,
  type SwapDirection,
  type SwapProvider,
} from "../lib/stable";
import { createFlashnetProvider, knownPoolIds, usdbAvailable } from "../lib/flashnet";
import {
  captureExitNodes,
  createEsplora,
  deriveFeeKey,
  ESPLORA_URL,
  feeKeyAddress,
  rootKey,
  runExitRound,
  type ExitJob,
  type ExitNode,
  type LeafProgress,
} from "../lib/unilateral";
import { captureFromNodes, planExit, signBundle, type ExitBundle, type ExitCapture, type ExitPlan } from "../lib/exitBundle";
import { DEPOSIT_CONFIRMATIONS, depositOutput } from "../lib/deposits";
import { autoClaimable } from "../lib/activity";

export type Phase = "boot" | "welcome" | "locked" | "unlocked";

export interface Balance {
  available: number;
  owned: number;
  incoming: number;
}

export interface ExitState {
  /** An in-browser exit started by an earlier version of the app, still being driven to completion. */
  job: ExitJob | null;
  progress: LeafProgress[];
  tip: number | null;
  running: boolean;
  error: string | null;
  /** An address from this wallet's own phrase, used only to pay exit fees. */
  feeAddress: string | null;
  lastCheckedAt: number | null;
  /**
   * Leaves captured for an exit bundle. While set, the exit is "armed": sending
   * and automatic leaf rearranging are paused, because either would make the
   * captured transactions stale.
   */
  capture: ExitCapture | null;
}

export type ClaimResult = { ok: true; creditedSats: number } | { ok: false; error: string };

/** A payment to the static deposit address that has not been claimed yet. */
export interface PendingDeposit {
  txid: string;
  vout: number;
  valueSats: number | null;
  confirmations: number;
  /** What the SSP would credit, once it will quote. Null until it is claimable. */
  creditSats: number | null;
  quoteError: string | null;
  /** When this wallet first saw the deposit. Epoch millis. */
  firstSeenAt: number;
}

/** True once the deposit is deep enough and the SSP has priced it. */
export function depositClaimable(d: PendingDeposit): boolean {
  return d.confirmations >= DEPOSIT_CONFIRMATIONS && d.creditSats !== null;
}

interface State {
  phase: Phase;
  storage: StorageHealth | null;
  settings: Settings;

  backupVerified: boolean;
  backupDeferred: boolean;

  /** Live only while unlocked. Both are zeroed on lock. */
  wallet: SparkWallet | null;
  key: CryptoKey | null;
  mnemonic: string | null;

  balance: Balance;
  /**
   * False from unlock until the first full sync. The balance is shown as a
   * loading placeholder in the meantime rather than a number that climbs as the
   * SDK counts leaves.
   */
  balanceLoaded: boolean;
  /** Spendable USDB, in base units (1e-6 USD). */
  usdbUnits: bigint;
  /**
   * USDB units one sat is worth right now, for showing figures in USD. Display
   * only, and null until a quote arrives — never used to size a swap.
   */
  unitsPerSat: number | null;
  activity: CachedActivity[];
  sparkAddress: string | null;
  staticDepositAddress: string | null;
  deposits: PendingDeposit[];
  /** "txid:vout" of every deposit a claim is in flight for. */
  claiming: string[];

  /** Sealed with the vault key; only loaded while unlocked. */
  contacts: Contact[];

  streamConnected: boolean;
  syncing: boolean;
  error: string | null;

  /**
   * Whether this wallet is hidden from public Spark explorers (sparkscan and
   * the public APIs). Read from the operators on unlock; null until known.
   */
  privacyEnabled: boolean | null;

  /** A conversion is in flight. */
  stableBusy: boolean;
  /** The outcome of the most recent conversion, for the balance area. */
  stableNote: string | null;

  exit: ExitState;

  /** Progress of the Argon2 derivation, so unlock can show something honest. */
  kdfProgress: number;
}

interface Actions {
  boot(): Promise<void>;
  createWallet(passphrase: string, mnemonic: string): Promise<void>;
  restoreWallet(passphrase: string, mnemonic: string): Promise<void>;
  unlock(passphrase: string): Promise<boolean>;
  lock(): Promise<void>;
  refresh(): Promise<void>;
  markBackupVerified(): Promise<void>;
  deferBackup(): Promise<void>;
  changePassphrase(current: string, next: string): Promise<boolean>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  setPrivacy(enabled: boolean): Promise<void>;
  setLeafLayout(layout: LeafLayout): Promise<void>;
  setStableMode(mode: StableMode): Promise<void>;
  moveToStable(sats: number): Promise<ConvertResult>;
  moveToBitcoin(units: bigint): Promise<ConvertResult>;
  /**
   * What it would take to move the whole USD balance back to bitcoin, including
   * whether bitcoin has to be converted in first to clear the pool's minimum.
   */
  planStableSweep(): Promise<SweepPlan | null>;
  /** Moves the whole USD balance to bitcoin, topping up first when it is too small to swap. */
  sweepStable(): Promise<boolean>;
  /**
   * Sets one side of the balance to an exact figure, converting the difference
   * from the other side. `target` is sats for "btc" and USDB units for "usd".
   */
  rebalance(anchor: "btc" | "usd", target: bigint): Promise<ConvertResult>;
  /** USDB units one sat fetches right now, before slippage. null if no quote. */
  quoteUnitsPerSat(): Promise<number | null>;
  /** What the USD balance would fetch in sats right now, after slippage. null if it cannot be quoted. */
  quoteUsdInSats(): Promise<number | null>;
  /**
   * Runs a bitcoin payment, converting just enough USDB first if the bitcoin in
   * the wallet does not cover `neededSats`. `allow` defaults to true in
   * whole-balance mode and must be opted into in separate mode.
   */
  withStableCover<T>(neededSats: number, pay: () => Promise<T>, opts?: { allow?: boolean }): Promise<T>;

  addContact(name: string, address: string, kind: ContactKind): Promise<void>;
  removeContact(id: string): Promise<void>;

  checkDeposits(): Promise<void>;
  claimDeposit(txid: string, vout: number): Promise<ClaimResult>;

  /** Captures every leaf and its ancestors from the operators and arms the exit. */
  captureForExit(): Promise<void>;
  planExitBundle(destination: string, feeRate: number): Promise<ExitPlan>;
  signExitBundle(plan: ExitPlan): Promise<ExitBundle>;
  cancelExitBundle(): Promise<void>;
  recommendedFeeRate(): Promise<number | null>;

  runExit(): Promise<void>;
  forgetExit(): Promise<void>;
  wipe(): Promise<void>;
  setError(e: string | null): void;
}

const EMPTY_BALANCE: Balance = { available: 0, owned: 0, incoming: 0 };

/** How long to wait for swapped sats to become spendable before paying anyway. */
const SETTLE_TIMEOUT_MS = 20_000;
const SETTLE_POLL_MS = 500;

/**
 * Waits until the wallet can actually spend `minSats`.
 *
 * A swap returning is not the same as its output being spendable — the
 * operators still have to settle it into selectable leaves. Paying in that gap
 * fails with "Total target amount exceeds available balance" even though the
 * USD was converted, which reads as the wallet refusing to spend money it
 * plainly has.
 *
 * Gives up after SETTLE_TIMEOUT_MS and lets the payment proceed regardless: if
 * the sats really have not landed the SDK says so, and that is a better outcome
 * than blocking for ever on a balance that may never reach the figure.
 */
async function waitForSpendable(wallet: SparkWallet, minSats: bigint): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    try {
      if (BigInt((await wallet.getBalance()).satsBalance.available) >= minSats) return;
    } catch {
      /* a failed read is not an answer; keep waiting until the deadline */
    }
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
  }
}

/**
 * Claims confirmed deposits without asking, when the user has turned that on
 * and the SSP's fee is within the ceiling they set.
 *
 * Opt-in, because claiming spends their money on a fee. The fee is recomputed
 * from this poll's quote rather than trusted from the setting alone, and a
 * deposit priced above the ceiling is left for a person to look at — never
 * claimed at whatever the SSP happens to be asking.
 */
async function autoClaim(get: () => State & Actions): Promise<void> {
  const { settings, deposits, claiming } = get();
  if (!settings.autoClaimDeposits) return;

  for (const d of deposits) {
    if (claiming.includes(`${d.txid}:${d.vout}`)) continue;
    if (!autoClaimable(d, { enabled: true, maxFeeSats: settings.autoClaimMaxFeeSats })) continue;
    // Sequential on purpose: each claim re-quotes, and the SSP prices a deposit
    // against the wallet's current state.
    await get().claimDeposit(d.txid, d.vout);
  }
}

const EMPTY_EXIT: ExitState = {
  job: null,
  progress: [],
  tip: null,
  running: false,
  error: null,
  feeAddress: null,
  lastCheckedAt: null,
  capture: null,
};

/* ------------------------------------------------------------------ */
/* Module-level runtime state that must not live in React state       */
/* ------------------------------------------------------------------ */

let provider: { wallet: SparkWallet; network: NetworkName; value: Promise<SwapProvider> } | null = null;

function swapProvider(wallet: SparkWallet, network: NetworkName): Promise<SwapProvider> {
  if (!provider || provider.wallet !== wallet || provider.network !== network) {
    const entry = { wallet, network, value: createFlashnetProvider(wallet, network) };
    provider = entry;
    // A failed initialisation must not be cached forever.
    entry.value.catch(() => {
      if (provider === entry) provider = null;
    });
  }
  return provider.value;
}

/** True while an automatic conversion runs, so they never overlap. */
let converting = false;
/** Depth of payments in flight, during which sats must not be auto-converted away. */
let payingDepth = 0;

const EXIT_POLL_MS = 60_000;
let exitTimer: ReturnType<typeof setInterval> | null = null;

const DEPOSIT_POLL_MS = 120_000;
let depositTimer: ReturnType<typeof setInterval> | null = null;

function stopTimers() {
  if (exitTimer) {
    clearInterval(exitTimer);
    exitTimer = null;
  }
  if (depositTimer) {
    clearInterval(depositTimer);
    depositTimer = null;
  }
}

function exitActive(s: State): boolean {
  return (!!s.exit.job && !s.exit.job.finishedAt) || !!s.exit.capture;
}

/** For components: sending, conversions and leaf changes are paused while this is true. */
export const selectExitLocked = (s: State) => exitActive(s);

function describeConversion(r: ConvertResult, direction: SwapDirection, amountIn: bigint): string | null {
  switch (r.status) {
    case "converted": {
      const done =
        direction === "toStable"
          ? `Converted ${r.amountIn.toLocaleString("en-US")} sats to ${formatUsd(r.amountOut)}.`
          : `Converted ${formatUsd(r.amountIn)} to ${r.amountOut.toLocaleString("en-US")} sats.`;
      if (r.change === undefined) return done;
      // Too small to swap on its own, so it stays put. Naming it "change" says
      // the remainder is expected, rather than leaving the user to wonder why
      // the balance did not reach zero.
      const change =
        direction === "toStable"
          ? `${r.change.toLocaleString("en-US")} sats`
          : formatUsd(r.change);
      return `${done} ${change} remains as change — below the smallest amount that can be converted.`;
    }
    case "skipped":
      if (r.reason === "nothing") return null;
      if (r.reason === "below-minimum") {
        return direction === "toStable"
          ? `Kept ${amountIn.toLocaleString("en-US")} sats as bitcoin — below the smallest amount that can be converted.`
          : "Kept as USD — below the smallest amount that can be converted.";
      }
      return "Left unconverted — no quote is available right now.";
    case "failed":
      return `Conversion failed: ${r.error}`;
  }
}

export const useWallet = create<State & Actions>((set, get) => ({
  phase: "boot",
  storage: null,
  settings: db.DEFAULT_SETTINGS,
  backupVerified: false,
  backupDeferred: false,
  wallet: null,
  key: null,
  mnemonic: null,
  balance: EMPTY_BALANCE,
  balanceLoaded: false,
  usdbUnits: 0n,
  unitsPerSat: null,
  activity: [],
  sparkAddress: null,
  staticDepositAddress: null,
  deposits: [],
  claiming: [],
  contacts: [],
  streamConnected: false,
  syncing: false,
  error: null,
  privacyEnabled: null,
  stableBusy: false,
  stableNote: null,
  exit: EMPTY_EXIT,
  kdfProgress: 0,

  setError: (e) => set({ error: e }),

  async boot() {
    const [storage, settings, verified, deferred, exists] = await Promise.all([
      checkStorage(),
      db.loadSettings(),
      db.loadBackupVerified(),
      db.loadBackupDeferred(),
      db.hasWallet(),
    ]);
    set({
      storage,
      settings,
      backupVerified: verified,
      backupDeferred: deferred,
      phase: exists ? "locked" : "welcome",
    });
  },

  async createWallet(passphrase, mnemonic) {
    const { vault, key } = await createVault(passphrase, mnemonic, (p) => set({ kdfProgress: p }));
    await db.saveVault(vault);
    await db.saveBackupVerified(false);
    await db.saveBackupDeferred(false);
    set({ kdfProgress: 0, backupVerified: false, backupDeferred: false });
    await attach(set, get, mnemonic, key);
  },

  async restoreWallet(passphrase, mnemonic) {
    const { vault, key } = await createVault(passphrase, mnemonic, (p) => set({ kdfProgress: p }));
    await db.saveVault(vault);
    // A restored phrase is by definition already backed up somewhere.
    await db.saveBackupVerified(true);
    await db.saveBackupDeferred(false);
    set({ kdfProgress: 0, backupVerified: true, backupDeferred: false });
    await attach(set, get, mnemonic, key);
  },

  async unlock(passphrase) {
    const vault = await db.loadVault();
    if (!vault) {
      set({ phase: "welcome" });
      return false;
    }
    set({ kdfProgress: 0 });
    const opened = await openVault(vault, passphrase, (p) => set({ kdfProgress: p }));
    set({ kdfProgress: 0 });
    if (!opened) return false;

    // The vault opens under whatever parameters it was written with. If those
    // are not the current ones, re-seal it now that the passphrase is in hand —
    // this is the only moment it can be done without asking the user again.
    let key = opened.key;
    if (vaultNeedsUpgrade(vault)) {
      try {
        const upgraded = await createVault(passphrase, opened.mnemonic, (p) =>
          set({ kdfProgress: p }),
        );
        // Contacts and any exit in progress are sealed with the old key.
        await db.resealAll(opened.key, upgraded.key);
        await db.saveVault(upgraded.vault);
        await db.clearActivityCache().catch(() => {});
        key = upgraded.key;
      } catch {
        // An upgrade that fails must not cost the user their unlock; the vault
        // on disk is untouched and will be retried next time.
      }
      set({ kdfProgress: 0 });
    }

    await attach(set, get, opened.mnemonic, key);
    return true;
  },

  async lock() {
    stopTimers();
    const { wallet } = get();
    if (wallet) {
      try {
        await wallet.cleanup();
      } catch {
        /* tearing down a dead connection is not an error worth surfacing */
      }
    }
    // The key and phrase are dropped here; that is the whole point of locking.
    set({
      phase: "locked",
      wallet: null,
      key: null,
      mnemonic: null,
      balance: EMPTY_BALANCE,
      balanceLoaded: false,
      usdbUnits: 0n,
      activity: [],
      sparkAddress: null,
      staticDepositAddress: null,
      deposits: [],
      claiming: [],
      contacts: [],
      streamConnected: false,
      stableBusy: false,
      stableNote: null,
      exit: EMPTY_EXIT,
      error: null,
    });
  },

  async refresh() {
    const { wallet, key, settings } = get();
    if (!wallet) return;
    set({ syncing: true });
    try {
      const [bal, transfers, spark, identity] = await Promise.all([
        wallet.getBalance(),
        wallet.getTransfers(50, 0),
        wallet.getSparkAddress(),
        wallet.getIdentityPublicKey().catch(() => undefined),
      ]);
      const context: ActivityContext = {
        ...(identity ? { ownIdentity: identity } : {}),
        poolIds: knownPoolIds,
      };
      const activity = transfers.transfers.map((t) => toActivity(t, context));
      set({
        balance: {
          available: Number(bal.satsBalance.available),
          owned: Number(bal.satsBalance.owned),
          incoming: Number(bal.satsBalance.incoming),
        },
        usdbUnits: usdbAvailable(bal.tokenBalances as Map<string, { availableToSendBalance: bigint }>, settings.network),
        balanceLoaded: true,
        activity,
        sparkAddress: spark,
        error: null,
      });
      if (key) await db.saveActivityCache(key, activity).catch(() => {});

      // The rate only matters when figures are shown in dollars, and a missing
      // quote simply leaves them in sats rather than showing a stale price.
      if (settings.stableMode !== "off" && stableSupported(settings.network)) {
        void get()
          .quoteUnitsPerSat()
          .then((r) => set({ unitsPerSat: r }))
          .catch(() => set({ unitsPerSat: null }));
      } else if (get().unitsPerSat !== null) {
        set({ unitsPerSat: null });
      }
    } catch (e) {
      set({ error: readableError(e) });
    } finally {
      set({ syncing: false });
    }
  },

  async markBackupVerified() {
    await db.saveBackupVerified(true);
    await db.saveBackupDeferred(false);
    set({ backupVerified: true, backupDeferred: false });
  },

  async deferBackup() {
    await db.saveBackupDeferred(true);
    set({ backupDeferred: true });
  },

  async changePassphrase(current, next) {
    const vault = await db.loadVault();
    if (!vault) return false;
    const opened = await openVault(vault, current, (p) => set({ kdfProgress: p }));
    set({ kdfProgress: 0 });
    if (!opened) return false;

    // New salt as well as a new key — reusing the salt would leak that the
    // passphrase changed without changing the derivation.
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const kdf = { ...KDF_PARAMS, salt };
    const key = await deriveKey(next, kdf, (p) => set({ kdfProgress: p }));

    // Contacts, an exit in progress and captured exit leaves must all survive:
    // re-seal them under the new key before the vault moves to it.
    await db.resealAll(opened.key, key);

    const { iv, ct } = await sealString(key, opened.mnemonic);
    // The current parameters, not the outgoing vault's: `key` above was derived
    // with these, and recording anything else makes the vault unopenable.
    await db.saveVault({ v: VAULT_VERSION, kdf, iv, ct });

    // The activity cache was sealed with the old key; it is only a cache.
    await db.clearActivityCache().catch(() => {});
    set({ key, kdfProgress: 0 });
    return true;
  },

  async updateSettings(patch) {
    const settings = { ...get().settings, ...patch };
    await db.saveSettings(settings);
    set({ settings });
  },

  /**
   * Privacy mode is operator-side state, not a local preference: it stops the
   * public Spark APIs and explorers returning anything for this wallet. It does
   * not hide anything from the operators themselves, and it changes nothing
   * on-chain.
   */
  async setPrivacy(enabled) {
    const { wallet } = get();
    if (!wallet) return;
    try {
      const settings = await wallet.setPrivacyEnabled(enabled);
      // Remember an explicit opt-out so the next unlock does not undo it.
      await db.savePrivacyOptOut(!enabled);
      set({ privacyEnabled: settings?.privateEnabled ?? enabled, error: null });
    } catch (e) {
      set({ error: readableError(e) });
    }
  },

  /**
   * Rearranges leaves now and re-initialises the SDK so its background
   * optimisation keeps to the new layout — otherwise it would quietly split
   * an exit-optimised wallet back into small denominations.
   */
  async setLeafLayout(layout) {
    const s = get();
    if (exitActive(s)) {
      set({ error: "A unilateral exit is in progress. Rearranging leaves now would change the leaves being exited." });
      return;
    }
    await get().updateSettings({ leafLayout: layout });
    if (!s.wallet || !s.mnemonic || !s.key) return;
    try {
      for await (const step of s.wallet.optimizeLeaves(layout === "exit" ? 0 : 1)) void step;
    } catch (e) {
      set({ error: readableError(e) });
    }
    await attach(set, get, s.mnemonic, s.key);
  },

  async setStableMode(mode) {
    const s = get();
    if (mode !== "off" && !stableSupported(s.settings.network)) {
      set({ error: "Stable balance needs USDB liquidity, which only exists on mainnet." });
      return;
    }
    if (exitActive(s)) {
      set({ error: "A unilateral exit is in progress. Finish or cancel it before changing the stable balance." });
      return;
    }
    const previous = s.settings.stableMode;
    await get().updateSettings({ stableMode: mode });
    if (!s.wallet) return;

    if (mode === "whole") {
      await autoConvert(get, set);
    } else if (mode === "off" && previous !== "off" && get().usdbUnits > 0n) {
      // "Off" means everything is bitcoin again — including a balance too small
      // for the pool to swap on its own, which moveToBitcoin would have quietly
      // declined and left stranded. The sweep converts a little bitcoin in
      // first when that is what it takes; if even that is impossible it reports
      // why, and Home keeps showing the USD so it cannot go unnoticed.
      await get().sweepStable();
    }
  },

  async moveToStable(sats) {
    const s = get();
    const amount = BigInt(Math.max(0, Math.floor(sats)));
    if (!s.wallet) return { status: "skipped", reason: "nothing" };
    set({ stableBusy: true });
    try {
      const p = await swapProvider(s.wallet, s.settings.network);
      const r = await convertToStable(p, amount, DEFAULT_SLIPPAGE_BPS, BigInt(s.balance.available));
      set({ stableNote: describeConversion(r, "toStable", amount) });
      if (r.status === "converted") await get().refresh();
      return r;
    } catch (e) {
      const r: ConvertResult = { status: "failed", error: readableError(e) };
      set({ stableNote: describeConversion(r, "toStable", amount) });
      return r;
    } finally {
      set({ stableBusy: false });
    }
  },

  async planStableSweep() {
    const s = get();
    if (!s.wallet) return null;
    try {
      const p = await swapProvider(s.wallet, s.settings.network);
      return await planStableSweep(p, {
        usdbAvailable: s.usdbUnits,
        btcAvailable: BigInt(s.balance.available),
      });
    } catch {
      return null;
    }
  },

  async sweepStable() {
    const s = get();
    if (!s.wallet) return false;
    set({ stableBusy: true });
    try {
      const p = await swapProvider(s.wallet, s.settings.network);
      const r = await sweepStableToBitcoin(p, {
        usdbAvailable: s.usdbUnits,
        btcAvailable: BigInt(s.balance.available),
        // The operators are authoritative for what the top-up actually
        // produced — and, as with paying, the swap returning does not mean the
        // USD has settled yet. Wait for it rather than sweeping a stale figure.
        usdbAfterTopUp: async () => {
          const expected = s.usdbUnits + 1n;
          const deadline = Date.now() + SETTLE_TIMEOUT_MS;
          for (;;) {
            await get().refresh();
            const now = get().usdbUnits;
            if (now >= expected || Date.now() >= deadline) return now;
            await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
          }
        },
      });
      const topUp = r.toppedUp
        ? ` ${r.toppedUp.sats.toLocaleString("en-US")} sats were converted to USD first so the balance cleared the pool's minimum.`
        : "";
      set({
        stableNote: `Converted ${formatUsd(r.usdbIn)} to ${r.satsOut.toLocaleString("en-US")} sats.${topUp}`,
      });
      await get().refresh();
      return true;
    } catch (e) {
      set({ stableNote: readableError(e) });
      return false;
    } finally {
      set({ stableBusy: false });
    }
  },

  async moveToBitcoin(units) {
    const s = get();
    if (!s.wallet) return { status: "skipped", reason: "nothing" };
    set({ stableBusy: true });
    try {
      const p = await swapProvider(s.wallet, s.settings.network);
      const r = await convertToBitcoin(p, units, DEFAULT_SLIPPAGE_BPS, s.usdbUnits);
      set({ stableNote: describeConversion(r, "toBitcoin", units) });
      if (r.status === "converted") await get().refresh();
      return r;
    } catch (e) {
      const r: ConvertResult = { status: "failed", error: readableError(e) };
      set({ stableNote: describeConversion(r, "toBitcoin", units) });
      return r;
    } finally {
      set({ stableBusy: false });
    }
  },

  async rebalance(anchor, target) {
    const s = get();
    if (!s.wallet) return { status: "skipped", reason: "nothing" };
    if (exitActive(s)) {
      const r: ConvertResult = { status: "failed", error: "A unilateral exit is in progress." };
      set({ stableNote: describeConversion(r, "toStable", 0n) });
      return r;
    }
    const current = { sats: BigInt(s.balance.available), usdbUnits: s.usdbUnits };
    const plan = planRebalance(anchor, target, current);
    if (plan.kind === "none") return { status: "skipped", reason: "nothing" };
    set({ stableBusy: true });
    try {
      const p = await swapProvider(s.wallet, s.settings.network);
      const r = await executeRebalance(p, plan, current);
      const amount = plan.kind === "exact-in" ? plan.amountIn : plan.amountOut;
      set({ stableNote: describeConversion(r, plan.direction, amount) });
      if (r.status === "converted") await get().refresh();
      return r;
    } catch (e) {
      const r: ConvertResult = { status: "failed", error: readableError(e) };
      set({ stableNote: describeConversion(r, plan.direction, 0n) });
      return r;
    } finally {
      set({ stableBusy: false });
    }
  },

  async quoteUnitsPerSat() {
    const s = get();
    if (!s.wallet || !stableSupported(s.settings.network)) return null;
    try {
      const p = await swapProvider(s.wallet, s.settings.network);
      const sample = 100_000n;
      const units = await p.quote("toStable", sample);
      return units > 0n ? Number(units) / Number(sample) : null;
    } catch {
      return null;
    }
  },

  async quoteUsdInSats() {
    const s = get();
    if (s.settings.stableMode === "off" || s.usdbUnits === 0n || !s.wallet) return 0;
    try {
      const p = await swapProvider(s.wallet, s.settings.network);
      return Number(withSlippage(await p.quote("toBitcoin", s.usdbUnits)));
    } catch {
      return null;
    }
  },

  async withStableCover<T>(neededSats: number, pay: () => Promise<T>, opts?: { allow?: boolean }): Promise<T> {
    const s = get();
    const allowed = opts?.allow ?? s.settings.stableMode === "whole";
    const covered = BigInt(Math.ceil(neededSats)) <= BigInt(s.balance.available);
    if (!allowed || covered || s.settings.stableMode === "off" || s.usdbUnits === 0n || !s.wallet) {
      return pay();
    }

    payingDepth++;
    set({ stableBusy: true });
    try {
      const p = await swapProvider(s.wallet, s.settings.network);
      const { result, swapped } = await payFromStable(p, {
        neededSats: BigInt(Math.ceil(neededSats)),
        btcAvailable: BigInt(s.balance.available),
        usdbAvailable: s.usdbUnits,
        pay,
        settle: (minSats) => waitForSpendable(s.wallet!, minSats),
      });
      if (swapped) {
        set({
          stableNote: `Converted ${formatUsd(swapped.usdbIn)} to ${swapped.satsOut.toLocaleString("en-US")} sats for this payment.`,
        });
      }
      return result;
    } finally {
      payingDepth--;
      set({ stableBusy: false });
      void get().refresh();
    }
  },

  /* ---------------------------------------------------------------- */
  /* contacts                                                          */
  /* ---------------------------------------------------------------- */

  async addContact(name, address, kind) {
    const s = get();
    if (!s.key) return;
    const trimmed = name.trim().slice(0, 60);
    if (!trimmed) return;
    const entry: Contact = {
      id: crypto.randomUUID(),
      name: trimmed,
      address: address.trim(),
      kind,
      network: s.settings.network,
      addedAt: Date.now(),
    };
    // Re-read before writing, so two quick saves cannot drop one another.
    const existing = await db.loadContacts(s.key);
    const next = [...existing.filter((c) => !(c.address === entry.address && c.network === entry.network)), entry];
    await db.saveContacts(s.key, next);
    set({ contacts: next });
  },

  async removeContact(id) {
    const s = get();
    if (!s.key) return;
    const next = (await db.loadContacts(s.key)).filter((c) => c.id !== id);
    await db.saveContacts(s.key, next);
    set({ contacts: next });
  },

  /* ---------------------------------------------------------------- */
  /* on-chain deposits                                                 */
  /* ---------------------------------------------------------------- */

  async checkDeposits() {
    const s = get();
    if (!s.wallet) return;
    try {
      const address = s.staticDepositAddress ?? (await s.wallet.getStaticDepositAddress());
      if (!get().staticDepositAddress) set({ staticDepositAddress: address });
      const utxos = await s.wallet.getUtxosForDepositAddress(address, 100, 0, true);
      const esplora = ESPLORA_URL[s.settings.network];
      const previous = new Map(get().deposits.map((d) => [`${d.txid}:${d.vout}`, d]));
      const deposits: PendingDeposit[] = [];

      for (const u of utxos) {
        const out = await depositOutput(esplora, u.txid, u.vout);
        const seen = previous.get(`${u.txid}:${u.vout}`);
        let creditSats: number | null = null;
        let quoteError: string | null = null;

        // Only quote once the deposit is deep enough to claim. Quoting earlier
        // spends a request to be told what the confirmation count already says,
        // and its failure reads to the user as something being wrong.
        if (out.confirmations >= DEPOSIT_CONFIRMATIONS) {
          try {
            const q = await s.wallet.getClaimStaticDepositQuote(u.txid, u.vout);
            creditSats = q.creditAmountSats;
          } catch (e) {
            quoteError = readableError(e);
          }
        }

        deposits.push({
          txid: u.txid,
          vout: u.vout,
          valueSats: out.valueSats,
          confirmations: out.confirmations,
          creditSats,
          quoteError,
          // Kept from the first sighting so the activity list can order deposits
          // against payments; the chain does not tell us when we noticed.
          firstSeenAt: seen?.firstSeenAt ?? Date.now(),
        });
      }

      if (get().wallet !== s.wallet) return;
      set({ deposits });
      await autoClaim(get);
    } catch {
      /* deposits are checked again on the next tick; never block the wallet on this */
    }
  },

  async claimDeposit(txid, vout) {
    const s = get();
    if (!s.wallet) return { ok: false, error: "The wallet is locked." };

    const id = `${txid}:${vout}`;
    if (get().claiming.includes(id)) {
      // Claiming twice concurrently would spend a second quote on a deposit the
      // first call is already consuming.
      return { ok: false, error: "That deposit is already being claimed." };
    }
    set({ claiming: [...get().claiming, id] });

    try {
      // A fresh quote: the fee is only honoured for the quote it was signed with.
      const q = await s.wallet.getClaimStaticDepositQuote(txid, vout);
      await s.wallet.claimStaticDeposit({
        transactionId: txid,
        outputIndex: vout,
        creditAmountSats: q.creditAmountSats,
        sspSignature: q.signature,
      });
      set({ error: null });
      await get().refresh();
      return { ok: true, creditedSats: q.creditAmountSats };
    } catch (e) {
      const error = readableError(e);
      set({ error });
      return { ok: false, error };
    } finally {
      set({ claiming: get().claiming.filter((c) => c !== id) });
      await get().checkDeposits();
    }
  },

  /* ---------------------------------------------------------------- */
  /* unilateral exit — bundle                                          */
  /* ---------------------------------------------------------------- */

  async captureForExit() {
    const s = get();
    if (!s.wallet || !s.mnemonic || !s.key) return;
    const network = s.settings.network;
    set({ exit: { ...get().exit, running: true, error: null } });
    try {
      const captured = await captureExitNodes(s.wallet);
      if (!captured.leafIds.length) throw new Error("There are no leaves above the dust limit to exit.");
      const capture = captureFromNodes(network, captured.leafIds, captured.nodes);
      await db.saveExitCapture(s.key, network, capture);
      set({ exit: { ...get().exit, capture, running: false } });
    } catch (e) {
      set({ exit: { ...get().exit, running: false, error: e instanceof Error ? e.message : readableError(e) } });
      return;
    }
    // Re-initialise with background leaf optimisation off, so the SDK does not
    // swap away the leaves that were just captured.
    await attach(set, get, s.mnemonic, s.key);
  },

  async planExitBundle(destination, feeRate) {
    const s = get();
    const capture = s.exit.capture;
    if (!s.mnemonic || !capture) throw new Error("Capture the leaves first.");
    const esplora = createEsplora(ESPLORA_URL[capture.network]);
    return planExit({
      capture,
      root: rootKey(s.mnemonic),
      destination,
      feeRate,
      txStatus: (txid) => esplora.txState(txid),
      buildChain: (leaf, map) => buildUnilateralExitChain(leaf as never, map as never) as unknown as Promise<ExitNode[]>,
    });
  },

  async signExitBundle(plan) {
    const s = get();
    if (!s.mnemonic) throw new Error("The wallet is locked.");
    const root = rootKey(s.mnemonic);
    const esplora = createEsplora(ESPLORA_URL[plan.network]);
    const coins = await esplora.confirmedUtxos(feeKeyAddress(deriveFeeKey(root), plan.network));
    return signBundle(plan, { root, coins, constructFeeBump: (hex, utxos, rate) => constructFeeBumpTx(hex, utxos, rate) });
  },

  async cancelExitBundle() {
    const s = get();
    await db.clearExitCapture(s.settings.network).catch(() => {});
    set({ exit: { ...get().exit, capture: null } });
    if (s.mnemonic && s.key) await attach(set, get, s.mnemonic, s.key);
  },

  async recommendedFeeRate() {
    try {
      return await createEsplora(ESPLORA_URL[get().settings.network]).recommendedFeeRate();
    } catch {
      return null;
    }
  },

  /* ---------------------------------------------------------------- */
  /* unilateral exit — in-browser engine (resumes an existing job)     */
  /* ---------------------------------------------------------------- */

  async runExit() {
    const s = get();
    const job = s.exit.job;
    if (!s.wallet || !s.mnemonic || !s.key || !job || s.exit.running) return;
    set({ exit: { ...s.exit, running: true, error: null } });
    try {
      const r = await runExitRound(job, {
        esplora: createEsplora(ESPLORA_URL[job.network]),
        root: rootKey(s.mnemonic),
        buildChain: (leaf, map) =>
          buildUnilateralExitChain(leaf as never, map as never) as unknown as Promise<ExitNode[]>,
        constructFeeBump: (hex, utxos, rate) => constructFeeBumpTx(hex, utxos, rate),
      });
      await db.saveExitJob(s.key, job.network, r.job);
      set({
        exit: { ...get().exit, job: r.job, progress: r.progress, tip: r.tip, running: false, lastCheckedAt: Date.now() },
      });
      if (r.done && exitTimer) {
        clearInterval(exitTimer);
        exitTimer = null;
      }
    } catch (e) {
      set({
        exit: {
          ...get().exit,
          running: false,
          error: e instanceof Error ? e.message : readableError(e),
          lastCheckedAt: Date.now(),
        },
      });
    }
  },

  async forgetExit() {
    if (exitTimer) {
      clearInterval(exitTimer);
      exitTimer = null;
    }
    await db.clearExitJob(get().settings.network).catch(() => {});
    set({ exit: { ...get().exit, job: null, progress: [], tip: null, running: false, error: null, lastCheckedAt: null } });
  },

  async wipe() {
    stopTimers();
    const { wallet } = get();
    if (wallet) {
      try {
        await wallet.cleanup();
      } catch {
        /* ignore */
      }
    }
    await db.wipeEverything();
    set({
      phase: "welcome",
      wallet: null,
      key: null,
      mnemonic: null,
      balance: EMPTY_BALANCE,
      balanceLoaded: false,
      usdbUnits: 0n,
      activity: [],
      sparkAddress: null,
      staticDepositAddress: null,
      deposits: [],
      claiming: [],
      contacts: [],
      backupVerified: false,
      backupDeferred: false,
      streamConnected: false,
      stableBusy: false,
      stableNote: null,
      exit: EMPTY_EXIT,
      error: null,
    });
  },
}));

/* ------------------------------------------------------------------ */

type Set = (partial: Partial<State>) => void;
type Get = () => State & Actions;

/**
 * Whole-balance mode: convert whatever bitcoin is sitting in the wallet.
 *
 * "Every payment immediately unless the swap would fail" — convertToStable
 * leaves anything below the AMM minimum, or unquotable, as bitcoin rather than
 * attempting it. Never runs during a payment (those sats are spoken for) or
 * during a unilateral exit.
 */
async function autoConvert(get: Get, set: Set): Promise<void> {
  const s = get();
  if (s.settings.stableMode !== "whole" || !s.wallet || converting || payingDepth > 0 || exitActive(s)) return;
  if (!stableSupported(s.settings.network)) return;
  const sats = BigInt(s.balance.available);
  if (sats <= 0n) return;

  converting = true;
  set({ stableBusy: true });
  try {
    const p = await swapProvider(s.wallet, s.settings.network);
    const r = await convertToStable(p, sats);
    set({ stableNote: describeConversion(r, "toStable", sats) });
    if (r.status === "converted") await get().refresh();
  } catch (e) {
    set({ stableNote: `Could not reach the swap service: ${readableError(e)}` });
  } finally {
    converting = false;
    set({ stableBusy: false });
  }
}

/**
 * Brings the SDK up for a mnemonic and wires its event stream into the store.
 *
 * The cached activity is painted first so the screen is not blank, then
 * `refresh()` overwrites it with what the operators actually say. The balance
 * itself stays a loading placeholder until that first refresh lands.
 */
async function attach(set: Set, get: Get, mnemonic: string, key: CryptoKey): Promise<void> {
  stopTimers();
  const { network, leafLayout } = get().settings;

  set({ balanceLoaded: false, balance: EMPTY_BALANCE, usdbUnits: 0n });
  const [cached, contacts, job, capture] = await Promise.all([
    db.loadActivityCache(key).catch(() => []),
    db.loadContacts(key).catch(() => []),
    db.loadExitJob<ExitJob>(key, network).catch(() => null),
    db.loadExitCapture<ExitCapture>(key, network).catch(() => null),
  ]);
  set({ activity: cached, contacts });

  const armed = !!capture || (!!job && !job.finishedAt);
  const { wallet } = await SparkWallet.getOrCreateWallet({
    mnemonicOrSeed: mnemonic,
    options: {
      network,
      // While an exit is armed, the leaves must stay exactly as captured.
      optimizationOptions: { auto: !armed, multiplicity: leafLayout === "exit" ? 0 : 1 },
    },
    forceReinit: true,
  });

  wallet.on(SparkWalletEvent.BalanceUpdate, (b) => {
    // Ignore the running tally the SDK emits while it first counts leaves.
    if (!get().balanceLoaded) return;
    set({
      balance: {
        available: Number(b.available),
        owned: Number(b.owned),
        incoming: Number(b.incoming),
      },
    });
  });
  const onIncoming = () => void get().refresh().then(() => autoConvert(get, set));
  wallet.on(SparkWalletEvent.TransferClaimed, onIncoming);
  wallet.on(SparkWalletEvent.DepositConfirmed, onIncoming);
  wallet.on(SparkWalletEvent.StreamConnected, () => set({ streamConnected: true }));
  wallet.on(SparkWalletEvent.StreamDisconnected, () => set({ streamConnected: false }));
  wallet.on(SparkWalletEvent.StreamReconnecting, () => set({ streamConnected: false }));

  let feeAddress: string | null = null;
  try {
    feeAddress = feeKeyAddress(deriveFeeKey(rootKey(mnemonic)), network);
  } catch {
    /* only needed for unilateral exit */
  }

  set({
    wallet,
    key,
    mnemonic,
    phase: "unlocked",
    exit: { ...EMPTY_EXIT, job, feeAddress, capture },
  });

  // Privacy is operator-side state, so it is read rather than assumed, and it
  // is turned on unless the user has explicitly opted out. Spark's own default
  // is public; a wallet that quietly publishes its history to sparkscan is not
  // a default anyone would choose knowingly. This runs on every unlock so that
  // switching networks — which is a different wallet with its own settings —
  // gets the same treatment as a freshly created one.
  //
  // Never allowed to block the wallet from opening.
  void (async () => {
    try {
      const current = await wallet.getWalletSettings();
      const isPrivate = current?.privateEnabled ?? false;
      if (!isPrivate && !(await db.loadPrivacyOptOut())) {
        const s = await wallet.setPrivacyEnabled(true);
        set({ privacyEnabled: s?.privateEnabled ?? true });
      } else {
        set({ privacyEnabled: isPrivate });
      }
    } catch {
      set({ privacyEnabled: null });
    }
  })();

  await get().refresh();

  void get().checkDeposits();
  depositTimer = setInterval(() => void get().checkDeposits(), DEPOSIT_POLL_MS);

  if (job && !job.finishedAt) {
    void get().runExit();
    exitTimer = setInterval(() => void get().runExit(), EXIT_POLL_MS);
  } else {
    void autoConvert(get, set);
  }
}

type SdkTransfer = Awaited<ReturnType<SparkWallet["getTransfers"]>>["transfers"][number];

const SETTLED = new Set(["COMPLETED", "TRANSFER_STATUS_COMPLETED"]);

/**
 * Transfer types the SDK uses for an AMM swap. PREIMAGE_SWAP and UTXO_SWAP are
 * deliberately absent: they are a Lightning payment and an on-chain deposit
 * claim, and the branches above catch them first.
 */
interface ActivityContext {
  /** This wallet's own identity, so a self-transfer is not read as a payment. */
  ownIdentity?: string;
  /** Identities of the AMM pools this wallet swaps through. */
  // ReadonlySet, because `Set` is shadowed by the store's own setter type below.
  poolIds?: ReadonlySet<string>;
}

const AMM_SWAP_TYPES = new Set(["SWAP", "COUNTER_SWAP", "PRIMARY_SWAP_V3", "COUNTER_SWAP_V3"]);

/**
 * Turns one SDK transfer into an activity row.
 *
 * `context` is what tells a swap from a payment. A BTC/USD swap is, underneath,
 * an ordinary Spark transfer to the pool, so without it every swap reads as
 * "Sent" for the whole balance — money apparently leaving the wallet when it
 * only changed denomination. Two independent signals are used, because either
 * one alone can miss: the transfer type, and whether the counterparty is a pool
 * this wallet swaps with. A transfer to the wallet's own identity is the SDK
 * rearranging leaves, which is not a payment either.
 */
function toActivity(t: SdkTransfer, context: ActivityContext = {}): CachedActivity {
  const outgoing = t.transferDirection === "OUTGOING";
  const amount = outgoing ? t.valueSentByWallet : t.valueReceivedByWallet;
  const type = String(t.type ?? "").toUpperCase();

  const party = outgoing
    ? (t.receivers?.[0]?.identityPublicKey ?? t.receiverIdentityPublicKey)
    : (t.senders?.[0]?.identityPublicKey ?? t.senderIdentityPublicKey);

  let kind: CachedActivity["kind"] = "spark";
  let swapDirection: CachedActivity["swapDirection"];
  if (type.includes("LIGHTNING") || type.includes("PREIMAGE")) kind = "lightning";
  else if (type.includes("DEPOSIT") || type.includes("EXIT") || type.includes("UTXO"))
    kind = "onchain";
  else if (AMM_SWAP_TYPES.has(type) || (party && context.poolIds?.has(party))) {
    kind = "swap";
    // Sats leaving for the pool bought USD; sats arriving sold it.
    swapDirection = outgoing ? "toStable" : "toBitcoin";
  } else if (party && context.ownIdentity && party === context.ownIdentity) {
    kind = "internal";
  } else if (!type) kind = "unknown";

  return {
    id: t.id,
    direction: outgoing ? "out" : "in",
    amountSats: Number(amount ?? 0),
    status: String(t.status ?? ""),
    settled: SETTLED.has(String(t.status ?? "").toUpperCase()),
    time: (t.createdTime ?? t.updatedTime ?? new Date()).getTime(),
    kind,
    ...(swapDirection ? { swapDirection } : {}),
    counterparty: party || undefined,
    updatedTime: t.updatedTime?.getTime() || undefined,
    // The SDK reports "no expiry" as epoch 0, not as a missing date.
    expiryTime: t.expiryTime?.getTime() || undefined,
    transferType: type || undefined,
    leafCount: t.leaves?.length,
  };
}
