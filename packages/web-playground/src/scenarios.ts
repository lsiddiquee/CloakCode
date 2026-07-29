import type { GatewayConnectInfo, SessionSummary } from "@cloakcode/protocol";
import { SESSIONS } from "./fixtures";

/**
 * Named states of the PWA the playground can start in. The fixtures cover the
 * happy path (a populated list), but several screens are only reachable when the
 * ingress *refuses* or *answers* something — the TOTP prompt, first-run
 * enrolment, "Connect an extension", the offline state. Those are states of the
 * bridge, not of the transcript, so they belong here rather than in fixtures.
 *
 * Pick one with `?scenario=<id>`; unknown ids fall back to `default`.
 */
export interface Scenario {
  readonly id: string;
  readonly label: string;
  /** One line, shown in the console index and the README table. */
  readonly summary: string;
  /** What `sessions.list` serves. */
  readonly sessions: SessionSummary[];
  /** How the ingress treats a socket that hasn't authenticated yet. */
  readonly gate: "open" | "needsAuth" | "enrolment";
  /** What `gateway.connectInfo` serves the "Connect an extension" view. */
  readonly connectInfo: GatewayConnectInfo;
  /** When set, the socket never opens — the app shows its offline state. */
  readonly unreachable?: boolean;
  /** Display-only `CloakCode:<id>` hint carried on auth refusals + enrolment. */
  readonly instanceId: string;
}

/** A plausible SHA-256 cert pin. Fixture material — no key exists for it. */
const FINGERPRINT =
  "82:F2:00:36:F2:E8:5B:1D:9C:44:0A:7E:31:B8:6C:52:AD:0F:93:E4:71:2C:88:D6:5A:39:FE:04:B7:1A:C3:60";

const PINNED_WSS: GatewayConnectInfo = {
  available: true,
  urls: ["wss://host.docker.internal:3544", "wss://192.168.1.24:3544"],
  insecure: false,
  fingerprint: FINGERPRINT,
};

const INSECURE_WS: GatewayConnectInfo = {
  available: true,
  urls: ["ws://192.168.1.24:3544"],
  insecure: true,
};

const BASE = {
  sessions: SESSIONS,
  gate: "open",
  connectInfo: PINNED_WSS,
  instanceId: "home",
} as const;

export const SCENARIOS: readonly Scenario[] = [
  {
    ...BASE,
    id: "default",
    label: "Connected gateway",
    summary:
      "Populated session list, two live blockers, a pinned wss:// provider listener.",
  },
  {
    ...BASE,
    id: "sign-in",
    gate: "needsAuth",
    label: "Operator sign-in (TOTP)",
    summary: "Every op refused with needsAuth until a 6-digit code is entered.",
  },
  {
    ...BASE,
    id: "first-run",
    gate: "enrolment",
    label: "First-run enrolment",
    summary:
      "MFA on but unconfirmed: only pairing is served, so the QR screen shows.",
  },
  {
    ...BASE,
    id: "insecure",
    connectInfo: INSECURE_WS,
    label: "Insecure provider link",
    summary:
      "The provider listener is the plain ws:// opt-in — the confidentiality warning.",
  },
  {
    ...BASE,
    id: "empty",
    sessions: [],
    label: "No sessions yet",
    summary: "A paired gateway with nothing to mirror — the empty state.",
  },
  {
    ...BASE,
    id: "offline",
    unreachable: true,
    label: "Gateway unreachable",
    summary: "The socket never opens — the app's offline/error state.",
  },
];

/** The scenario named by `?scenario=`, falling back to the first one. */
export function resolveScenario(search: string): Scenario {
  const fallback = SCENARIOS[0] as Scenario;
  const wanted = new URLSearchParams(search).get("scenario");
  if (!wanted) return fallback;
  const found = SCENARIOS.find((s) => s.id === wanted);
  if (found) return found;
  console.warn(
    `[playground] unknown scenario "${wanted}" — using "${fallback.id}"`,
  );
  return fallback;
}
