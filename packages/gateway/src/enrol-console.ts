import { otpauthUri } from "./totp.js";
import { qrTerminal } from "./qr-terminal.js";

/**
 * Console lines for STRICT operator enrolment (drift audit S7). The base32 TOTP
 * secret already persists to the `0600` secret file, so we **never** print it —
 * or the otpauth URI, which embeds it — to stdout, which on a container is a
 * **persistent** sink (`docker logs`). The scannable QR is shown **only on an
 * interactive TTY** — the legitimate transient out-of-band channel; a headless
 * (no-TTY) run is pointed at the `0600` file instead (retrieve it once, or use
 * browser/PWA enrolment, which shows the QR in the app).
 */
export function strictEnrolmentLines(opts: {
  isTTY: boolean;
  secret: string;
  /** Authenticator account label (the otpauth `account`, e.g. the instance id). */
  account: string;
  /** Path of the `0600` secret file. */
  file: string;
}): string[] {
  if (opts.isTTY) {
    return [
      "[cloakcode-gateway] strict enrolment — scan this QR, then enter a code in the app:",
      qrTerminal(otpauthUri(opts.secret, opts.account)),
    ];
  }
  return [
    `[cloakcode-gateway] strict enrolment — no TTY to show the QR. The TOTP secret is in ` +
      `${opts.file} (mode 0600); retrieve it out-of-band (e.g. 'docker exec … cat') or use ` +
      `browser enrolment (CLOAKCODE_MFA_ENROL=browser), which shows the QR in the app.`,
  ];
}
