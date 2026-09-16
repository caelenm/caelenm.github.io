/**
 * Bitcoin address validation for anything that moves money on-chain.
 *
 * A withdrawal is irreversible and its destination is typed or pasted by hand,
 * so this is the last point at which a mistake is still free. Two mistakes
 * matter and both are caught here:
 *
 *   Typos.    bech32 and base58 both carry checksums, so a mistyped address is
 *             detectable locally with certainty. Sending to a mistyped address
 *             burns the money — nobody holds the key to it.
 *   Networks. A mainnet address on a regtest wallet, or the reverse, is a
 *             different chain entirely.
 *
 * The cooperative exit previously accepted any string longer than twelve
 * characters and left both checks to the SSP. Trusting a counterparty to
 * validate the destination of the user's own money is the wrong default: if it
 * accepts what we should have rejected, the loss is permanent and ours.
 */
import * as btc from "@scure/btc-signer";
import { bitcoinNetwork, type ExitNetwork } from "./unilateral.ts";

export type AddressCheck = { ok: true } | { ok: false; reason: string };

const CHAIN_NAME: Record<ExitNetwork, string> = {
  MAINNET: "mainnet",
  REGTEST: "regtest",
};

/** The chain an address belongs to, or null when it is not a valid address anywhere. */
export function addressNetwork(address: string): ExitNetwork | null {
  const trimmed = address.trim();
  for (const network of ["MAINNET", "REGTEST"] as const) {
    try {
      btc.Address(bitcoinNetwork(network)).decode(trimmed);
      return network;
    } catch {
      /* try the other chain */
    }
  }
  return null;
}

/**
 * Checks `address` is a well-formed address on `network`.
 *
 * Decoding is the check: @scure/btc-signer verifies the checksum and the
 * network prefix, so anything it accepts is spendable and anything it rejects
 * is not worth sending to. The distinct "wrong chain" message exists because
 * that is the error a user can actually act on — it usually means they pasted
 * from the wrong wallet.
 */
export function validateOnchainAddress(address: string, network: ExitNetwork): AddressCheck {
  const trimmed = address.trim();
  if (!trimmed) return { ok: false, reason: "Enter a Bitcoin address." };

  // Whitespace inside an address is never valid and usually comes from a bad
  // copy; saying so beats "not a valid address".
  if (/\s/.test(trimmed)) {
    return { ok: false, reason: "That address contains a space. Check it was copied whole." };
  }

  try {
    btc.Address(bitcoinNetwork(network)).decode(trimmed);
    return { ok: true };
  } catch {
    const actual = addressNetwork(trimmed);
    if (actual && actual !== network) {
      return {
        ok: false,
        reason: `That is a ${CHAIN_NAME[actual]} address, but this wallet is on ${CHAIN_NAME[network]}. Sending there would lose the money.`,
      };
    }
    return {
      ok: false,
      reason: "That is not a valid Bitcoin address — check it for a typo. The checksum does not match.",
    };
  }
}
