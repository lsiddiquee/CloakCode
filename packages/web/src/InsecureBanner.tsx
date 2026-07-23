import type { JSX } from "react";

/**
 * The consolidated **insecure-mode** warning (docs/04). Rendered whenever a leg
 * of the setup is unencrypted, listing each `aspect` in an expandable detail
 * view. Worded as a **confidentiality** loss — the transcript + answers are
 * readable on the network — NOT an access one: sign-in (TOTP / token) still gates
 * *who* may connect. Renders nothing when there is nothing insecure.
 */
export function InsecureBanner({
  aspects,
}: {
  aspects: string[];
}): JSX.Element | null {
  if (aspects.length === 0) return null;
  return (
    <details className="insecure-banner" role="alert">
      <summary>
        <span className="insecure-badge">INSECURE</span>
        <span>Traffic isn’t encrypted — readable on the network. Details…</span>
      </summary>
      <ul className="insecure-list">
        {aspects.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
      <p className="insecure-note">
        Sign-in (TOTP / token) still controls <em>who</em> can connect — only
        confidentiality is lost. Fix it with a private tunnel or an encrypted
        overlay (or the default <code>wss://</code> provider link).
      </p>
    </details>
  );
}
