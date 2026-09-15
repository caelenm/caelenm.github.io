/**
 * Automatic locking is deliberately absent.
 *
 * The wallet is unlocked once and stays unlocked for as long as the page lives.
 * There is no idle timer and no lock on tab close, because being re-prompted
 * every few minutes pushes people toward short, memorable passphrases — which
 * costs more security than the timer buys.
 *
 * What still holds:
 *   - The seed is encrypted at rest with Argon2id + AES-GCM. A stolen laptop
 *     still needs the passphrase.
 *   - The key and the mnemonic live in memory only. Closing the tab or reloading
 *     destroys them, so the next visit asks again.
 *   - "Lock now" in Settings drops them immediately.
 *
 * The key is deliberately NOT kept in sessionStorage to survive reloads. That
 * would put raw key material somewhere a script can read it, in exchange for
 * skipping one prompt.
 */
export function useIdleLock(): void {
  // Intentionally empty. Kept as a named no-op so the decision above stays
  // written down next to where a timer would otherwise be reintroduced.
}
