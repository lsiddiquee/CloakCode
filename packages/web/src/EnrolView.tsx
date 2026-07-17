import { useEffect, useState } from "react";
import { beginEnrolment, submitAuthCode, type EnrolProvisioning } from "./auth";
import { qrSvg } from "./qr";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; provisioning: EnrolProvisioning };

/**
 * First-run TOTP enrolment (docs/04, F2a): the ingress serves only pairing until
 * a code is verified. Fetch the provisioning (`enrol.begin`), show the QR to scan
 * into an authenticator app (or, in strict mode, tell the operator to scan the
 * out-of-band QR), then verify one code to enable MFA. On success `onDone` fires.
 */
export function EnrolView({ onDone }: { onDone: () => void }): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    beginEnrolment().then(
      (provisioning) => live && setPhase({ kind: "ready", provisioning }),
      (e) =>
        live &&
        setPhase({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        }),
    );
    return () => {
      live = false;
    };
  }, []);

  async function verify(): Promise<void> {
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

  if (phase.kind === "loading") {
    return (
      <div className="modal-backdrop">
        <div className="modal auth">
          <p className="hint">Preparing pairing…</p>
        </div>
      </div>
    );
  }
  if (phase.kind === "error") {
    return (
      <div className="modal-backdrop">
        <div className="modal auth">
          <h2>Pairing unavailable</h2>
          <p className="hint error">{phase.message}</p>
        </div>
      </div>
    );
  }

  const { otpauthUri, secret } = phase.provisioning;
  return (
    <div className="modal-backdrop">
      <form
        className="modal auth"
        onSubmit={(e) => {
          e.preventDefault();
          void verify();
        }}
      >
        <h2>Set up two-factor auth</h2>
        {otpauthUri ? (
          <>
            <p className="hint">
              Scan with an authenticator app (Google Authenticator, 1Password,
              …):
            </p>
            <div
              className="qr"
              dangerouslySetInnerHTML={{ __html: qrSvg(otpauthUri) }}
            />
            {secret && (
              <p className="hint">
                Or enter this secret manually: <code>{secret}</code>
              </p>
            )}
          </>
        ) : (
          <p className="hint">
            Scan the QR shown on your gateway console (or in VS Code), then
            enter a code below to finish pairing.
          </p>
        )}
        <p className="hint">Then enter a code to finish enabling MFA:</p>
        <input
          className="auth-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={8}
          placeholder="123456"
          value={code}
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
          {busy ? "Verifying…" : "Enable"}
        </button>
      </form>
    </div>
  );
}
