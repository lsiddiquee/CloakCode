/**
 * Transcript scroll persistence + the restore decision, extracted from
 * `SessionView` so the logic is unit-testable without a layout engine (jsdom has
 * none). `readScroll`/`writeScroll` round-trip through `sessionStorage` (survives
 * a PWA reload, e.g. a phone lock/unlock); `nextScrollAction` is a pure state
 * machine the scroll effect drives with live DOM measurements.
 */

export interface SavedScroll {
  top: number;
  atBottom: boolean;
}

const key = (sessionId: string): string => `cc-scroll:${sessionId}`;

export function readScroll(sessionId: string): SavedScroll | null {
  try {
    const raw = sessionStorage.getItem(key(sessionId));
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (
      v &&
      typeof v === "object" &&
      typeof (v as SavedScroll).top === "number" &&
      typeof (v as SavedScroll).atBottom === "boolean"
    )
      return v as SavedScroll;
  } catch {
    // no/blocked sessionStorage
  }
  return null;
}

export function writeScroll(sessionId: string, value: SavedScroll): void {
  try {
    sessionStorage.setItem(key(sessionId), JSON.stringify(value));
  } catch {
    // no/blocked sessionStorage — position just won't persist
  }
}

export type ScrollAction =
  | { kind: "wait" } // content not tall enough to reach the saved spot yet
  | { kind: "restore"; top: number } // restore a saved mid-read position
  | { kind: "stick" } // follow the latest content to the bottom
  | { kind: "none" }; // leave the scroll where the user put it

/**
 * Decide what the transcript scroll should do on a content measurement. The
 * transcript streams in AFTER mount, so a restore must wait until the content is
 * tall enough to reach the saved offset (the earlier bug restored at
 * `scrollHeight ≈ 0`, clamping to the top). Once restored — or when there's
 * nothing to restore — normal stick-to-bottom applies.
 */
export function nextScrollAction(args: {
  saved: SavedScroll | null;
  restored: boolean;
  stick: boolean;
  scrollHeight: number;
  clientHeight: number;
}): ScrollAction {
  const { saved, restored, stick, scrollHeight, clientHeight } = args;
  if (!restored && saved && !saved.atBottom) {
    if (scrollHeight - clientHeight < saved.top) return { kind: "wait" };
    return { kind: "restore", top: saved.top };
  }
  return stick ? { kind: "stick" } : { kind: "none" };
}
