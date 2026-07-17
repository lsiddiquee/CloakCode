import qrcode from "qrcode-generator";

/**
 * Render `text` as a scannable QR for a terminal, using Unicode half-blocks so
 * two QR module rows share one character row (roughly square on-screen). Each
 * cell is dark = a foreground block; a light **quiet zone** border is included so
 * scanners lock on. Pure — no I/O — so it is unit-testable. Used once by the
 * standalone gateway to show the operator-TOTP pairing code (docs/04, F2a); the
 * embedded bridge renders its QR as SVG in a webview instead.
 */
export function qrTerminal(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 2; // light border (modules) around the symbol

  const dark = (row: number, col: number): boolean => {
    const r = row - quiet;
    const c = col - quiet;
    return (
      r >= 0 && r < count && c >= 0 && c < count && qr.isDark(r, c) === true
    );
  };

  const size = count + quiet * 2;
  const lines: string[] = [];
  for (let row = 0; row < size; row += 2) {
    let line = "";
    for (let col = 0; col < size; col++) {
      const top = dark(row, col);
      const bottom = row + 1 < size && dark(row + 1, col);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
