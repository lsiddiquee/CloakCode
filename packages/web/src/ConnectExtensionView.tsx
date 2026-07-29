import { useEffect, useState, type JSX } from "react";
import {
  formatPinnedGatewayUrl,
  type GatewayConnectInfo,
} from "@cloakcode/protocol";
import { fetchConnectInfo, isBridgeInsecure } from "./bridge";
import { InsecureBanner } from "./InsecureBanner";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; info: GatewayConnectInfo };

/** Copy `value` to the clipboard, flipping the label to a tick briefly. */
function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}): JSX.Element {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn small"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          },
          () => {
            /* clipboard blocked — the value is visible to copy manually */
          },
        );
      }}
    >
      {done ? "Copied ✓" : label}
    </button>
  );
}

/** The settings an operator copies into the extension to pair it over wss. */
function ConnectDetails({ info }: { info: GatewayConnectInfo }): JSX.Element {
  const aspects = [
    ...(info.insecure
      ? [
          "The extension (provider) link is a plain ws:// connection — the provider token and the mirrored transcript cross the network in clear.",
        ]
      : []),
    ...(isBridgeInsecure()
      ? ["This phone’s own connection to the gateway is plain http/ws."]
      : []),
  ];
  return (
    <>
      <InsecureBanner aspects={aspects} />
      <p className="hint">
        {info.insecure ? (
          <>
            Add these to the CloakCode <strong>extension</strong> settings in VS
            Code to connect it to this gateway over a plain <code>ws://</code>{" "}
            link — <strong>not encrypted</strong>, so use it only on a trusted
            network:
          </>
        ) : (
          <>
            Add these to the CloakCode <strong>extension</strong> settings in VS
            Code to connect it to this gateway over an encrypted, pinned{" "}
            <code>wss://</code> link. The URL below already{" "}
            <strong>carries this gateway&rsquo;s certificate pin</strong>, so
            one paste is enough:
          </>
        )}
      </p>
      <ol className="connect-steps">
        <li>
          <div className="connect-label">
            Gateway URL
            <code className="connect-setting">cloakcode.gatewayUrl</code>
          </div>
          {info.urls.length === 0 && (
            <p className="hint dim">
              No reachable address detected — use your gateway host with the TLS
              port.
            </p>
          )}
          {info.urls.map((u) => {
            const value = info.fingerprint
              ? formatPinnedGatewayUrl(u, info.fingerprint)
              : u;
            return (
              <div className="connect-value" key={u}>
                <code className="wrap">{value}</code>
                <CopyButton value={value} />
              </div>
            );
          })}
        </li>
        {info.fingerprint && (
          <li>
            <div className="connect-label">
              Certificate fingerprint
              <code className="connect-setting">
                cloakcode.gatewayCertFingerprint
              </code>
            </div>
            <p className="hint dim">
              Already included in the URL above — copy it here only if you
              prefer to keep the URL bare. The extension verifies the exact
              certificate on every connection and refuses a mismatch.
            </p>
            <div className="connect-value">
              <code className="wrap">{info.fingerprint}</code>
              <CopyButton value={info.fingerprint} />
            </div>
          </li>
        )}
      </ol>
      {!info.insecure && (
        <p className="hint dim">
          The fingerprint is a public integrity pin, not a secret — but read it
          only from here or the gateway&rsquo;s console, never from an error
          message reporting what some other server presented.
        </p>
      )}
    </>
  );
}

/**
 * "Connect an extension" (C4): the authenticated operator fetches how to pair an
 * EXTENSION with this gateway's native-TLS (wss) provider listener — the URL(s),
 * the SHA-256 fingerprint pin, and the cert (docs/04 "Closing the gap"). This is
 * the primary, out-of-band delivery channel for the pin (behind the tunnel +
 * TOTP); the gateway console is the fallback. Nothing here is secret.
 */
export function ConnectExtensionView({
  onBack,
}: {
  onBack: () => void;
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    fetchConnectInfo().then(
      (info) => live && setPhase({ kind: "ready", info }),
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

  return (
    <div className="app">
      <header className="appbar">
        <button className="icon-btn" onClick={onBack} title="Back">
          ‹
        </button>
        <div className="title">Connect an extension</div>
      </header>
      <main className="content connect-ext">
        {phase.kind === "loading" && (
          <p className="hint">Fetching connection details…</p>
        )}
        {phase.kind === "error" && (
          <p className="hint error">{phase.message}</p>
        )}
        {phase.kind === "ready" && !phase.info.available && (
          <div className="empty">
            <p className="hint">This gateway isn’t serving native TLS (wss).</p>
            <p className="hint dim">
              Set <code>CLOAKCODE_TLS_PORT</code> on the gateway to enable a
              direct encrypted provider link, or front it with an overlay /
              reverse proxy (Tailscale, WireGuard, Caddy) and use a plain{" "}
              <code>ws://</code> URL on loopback.
            </p>
          </div>
        )}
        {phase.kind === "ready" && phase.info.available && (
          <ConnectDetails info={phase.info} />
        )}
      </main>
    </div>
  );
}
