import { useState } from "react";
import { submitAuthCode } from "./auth";

/**
 * The operator TOTP prompt (docs/04, F2a): shown when the bridge/gateway refuses
 * a socket with `needsAuth`. The operator enters the 6-digit code from their
 * authenticator app; "remember this device" asks for a long-lived (30d) token so
 * the phone stays signed in. On success the token is stored and `onDone` fires.
 */
export function AuthPrompt({ onDone }: { onDone: () => void }): JSX.Element {
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await submitAuthCode(code.trim(), remember);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form
        className="modal auth"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>Enter your code</h2>
        <p className="hint">
          Open your authenticator app and enter the 6-digit CloakCode code.
        </p>
        <input
          className="auth-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={8}
          placeholder="123456"
          value={code}
          autoFocus
          onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
        />
        <label className="auth-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Remember this device for 30 days
        </label>
        {error && <p className="hint error">{error}</p>}
        <button
          className="btn"
          type="submit"
          disabled={busy || code.trim().length < 6}
        >
          {busy ? "Verifying…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
