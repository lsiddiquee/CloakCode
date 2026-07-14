import { cloakcodeHelloSchema, type CloakcodeHello } from "@cloakcode/protocol";

/** Build a minimal CloakCode knock frame (JSON string) for the given role. */
export function knockFrame(role: CloakcodeHello["role"]): string {
  return JSON.stringify({ type: "cloakcode.hello", role });
}

/**
 * True if `text` is the gateway's answering knock (`cloakcode.hello`, role
 * `gateway`) — the signal that a probed/connected peer really is a CloakCode
 * gateway, before we reveal any provider info.
 */
export function isGatewayKnock(text: string): boolean {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return false;
  }
  const parsed = cloakcodeHelloSchema.safeParse(json);
  return parsed.success && parsed.data.role === "gateway";
}
