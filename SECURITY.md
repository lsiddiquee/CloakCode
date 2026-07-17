# Security policy

## Supported versions

CloakCode is pre-1.0. Security fixes are applied to the latest release and the `main` branch. Older
releases are not maintained separately.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting flow:

1. Open this repository's **Security** tab.
2. Select **Report a vulnerability**.
3. Include affected versions, reproduction steps, impact, and any suggested mitigation.

Do not open a public issue for an undisclosed vulnerability. Do not include secrets, tokens, raw
prompts, workspace code, or other sensitive data in a report; use minimal redacted examples.

CloakCode's core security constraints are documented in
[docs/04-security-and-compliance.md](docs/04-security-and-compliance.md). In particular, reports about
code synchronization, unbounded egress, non-loopback bridge binding, provenance loss, or sensitive
logging are treated as security issues.
