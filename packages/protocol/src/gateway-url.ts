/**
 * The **pairing URL** codec shared by the gateway (which prints it) and the
 * extension (which consumes it). Pure — no I/O, no `vscode`, no `ws`.
 *
 * A self-signed gateway is trusted by pinning its certificate's SHA-256
 * fingerprint, which the operator must carry **out-of-band** (docs/04). Carrying
 * the host and the pin as two separate settings makes them driftable — a stale
 * pin against a new host, or a one-character typo in a field nothing validates
 * (cost real time 2026-07-27). So the gateway also publishes them joined:
 *
 * ```text
 * wss://host.docker.internal:7901#fp=82F20036F2E8…
 * ```
 *
 * The pin rides in the **fragment** because a fragment is never transmitted:
 * a query string would land in the gateway's own access logs and in any proxy
 * in between. The fingerprint is public material (integrity, not secrecy), but
 * a URL should still stay a URL.
 */

/** Canonicalize a fingerprint for comparison: hex only, uppercase. */
export function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}

/**
 * The first 12 hex chars — enough to compare two fingerprints by eye, useless to
 * paste. Anything user-visible (errors, logs) uses this rather than the full
 * value: a fingerprint read off the wire is chosen by whoever answered, so
 * printing it in full offers a ready-made "fix" that re-pins to the impostor,
 * and echoing the configured one spreads the pin into shared logs.
 */
export function shortFingerprint(fingerprint: string): string {
  return normalizeFingerprint(fingerprint).slice(0, 12) + "\u2026";
}

/** A gateway URL split into the address to dial and the pin it carried. */
export interface PinnedGatewayUrl {
  /** The URL with the pin fragment removed — what actually gets dialled. */
  url: string;
  /** Normalized SHA-256 pin from `#fp=`, when the URL carried one. */
  fingerprint?: string;
}

const FP_FRAGMENT = /^fp=(.*)$/i;

/**
 * Join an address and a pin into the single copy-paste pairing URL.
 * Any existing pin fragment is replaced, never appended to.
 */
export function formatPinnedGatewayUrl(
  url: string,
  fingerprint: string,
): string {
  const { url: bare } = splitPinnedGatewayUrl(url);
  return `${bare}#fp=${normalizeFingerprint(fingerprint)}`;
}

/**
 * Split a configured gateway URL into its address and (optional) pin.
 *
 * **Fails closed.** A fragment that is present but unusable throws rather than
 * being ignored: silently discarding a pin would downgrade a pinned link to an
 * unpinned one — exactly the outcome pinning exists to prevent.
 */
export function splitPinnedGatewayUrl(raw: string): PinnedGatewayUrl {
  const trimmed = raw.trim();
  const hash = trimmed.indexOf("#");
  if (hash < 0) return { url: trimmed };

  const url = trimmed.slice(0, hash);
  const fragment = trimmed.slice(hash + 1).trim();
  if (!fragment) return { url };

  const match = FP_FRAGMENT.exec(fragment);
  if (!match) {
    throw new Error(
      `cloakcode: gateway URL has an unrecognized "#${fragment}" fragment ` +
        `(the only supported fragment is "#fp=<certificate fingerprint>")`,
    );
  }
  const fingerprint = normalizeFingerprint(match[1] ?? "");
  if (fingerprint.length !== 64) {
    throw new Error(
      `cloakcode: gateway URL carries an unusable "#fp=" pin — a SHA-256 ` +
        `certificate fingerprint is 64 hex characters. Copy the pin from the ` +
        `gateway's own console.`,
    );
  }
  return { url, fingerprint };
}

/**
 * A gateway URL safe to log: the pin fragment is truncated to
 * {@link shortFingerprint}. Never throws — this sits on the logging path, so a
 * malformed URL is passed through as-is rather than breaking the log line.
 */
export function redactPinnedGatewayUrl(raw: string): string {
  const hash = raw.indexOf("#");
  if (hash < 0) return raw;
  const match = FP_FRAGMENT.exec(raw.slice(hash + 1).trim());
  if (!match) return raw;
  return `${raw.slice(0, hash)}#fp=${shortFingerprint(match[1] ?? "")}`;
}
