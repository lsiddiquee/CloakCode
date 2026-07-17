import qrcode from "qrcode-generator";

/**
 * Encode `text` as a QR and return inline **SVG markup** (a string of `<rect>`s,
 * not a rasterized image), so rendering is just painting text — no canvas/PNG.
 * `qrcode-generator` is a tiny, zero-dependency encoder; type `0` picks the
 * smallest QR that fits, `M` is medium error correction. Used for the
 * operator-TOTP pairing QR (docs/04, F2a).
 */
export function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
}
