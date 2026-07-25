import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

/** New complete lines since the last read, plus whether a shrink/reset occurred. */
export interface TailReadResult {
  /** Complete (newline-terminated) lines read since the last call, in order. */
  lines: string[];
  /**
   * True when the file shrank below the saved offset (truncation / rotation, e.g.
   * the 581 MB→85 MB debug-log recycle) — the offset + decoder were reset to 0 and
   * these `lines` are a FRESH read from the start. The caller must rebuild (reset
   * its parser + tell the client to clear), per docs/02.6 §4.32.
   */
  reset: boolean;
}

/**
 * A resumable, byte-offset **tail reader** for an append-only JSONL log — the
 * "file pointer" half of the offset-streaming fix (docs/02.6 §4.32). Each
 * {@link read} streams only the bytes past the saved offset via a chunked
 * `createReadStream` (never `readFile(…,"utf8")`, so it can't hit V8's ~512 MiB
 * string cap, §4.31), decodes with a {@link StringDecoder} so a multibyte UTF-8
 * char split across a chunk boundary isn't corrupted, and returns only COMPLETE
 * (newline-terminated) lines — buffering a partial trailing line until its
 * newline arrives (so a half-written record is never parsed twice). Detects
 * shrink/rotation (`size < offset`) and resets. Pure node/fs — unit-testable.
 */
export class TailReader {
  private offset = 0;
  private partial = "";
  private decoder = new StringDecoder("utf8");

  constructor(
    private readonly file: string,
    /** Chunk size for the streaming read (bytes). Bounds peak memory. */
    private readonly chunkSize = 1 << 20, // 1 MiB
  ) {}

  /** Bytes consumed so far (the resume point). */
  get position(): number {
    return this.offset;
  }

  /** Read new complete lines since the last call. `size` is optional (the caller
   *  may already have `stat`ed); it is fetched when omitted. */
  async read(size?: number): Promise<TailReadResult> {
    let end: number;
    if (size === undefined) {
      try {
        end = (await stat(this.file)).size;
      } catch {
        return { lines: [], reset: false }; // missing/unreadable — nothing yet
      }
    } else {
      end = size;
    }

    let reset = false;
    if (end < this.offset) {
      // Truncation / rotation → the offset points past the (new, shorter) file.
      this.offset = 0;
      this.partial = "";
      this.decoder = new StringDecoder("utf8");
      reset = true;
    }
    if (end <= this.offset) return { lines: [], reset };

    const lines: string[] = [];
    const start = this.offset;
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(this.file, {
        start,
        end: end - 1, // createReadStream's `end` is INCLUSIVE
        highWaterMark: this.chunkSize,
      });
      stream.on("data", (chunk) => {
        this.partial += this.decoder.write(chunk as Buffer);
        let nl = this.partial.indexOf("\n");
        while (nl !== -1) {
          lines.push(this.partial.slice(0, nl));
          this.partial = this.partial.slice(nl + 1);
          nl = this.partial.indexOf("\n");
        }
      });
      stream.on("end", () => {
        this.offset = end;
        resolve();
      });
      stream.on("error", reject);
    });
    return { lines, reset };
  }

  /**
   * Flush any buffered partial (a complete record that lacks a trailing newline —
   * e.g. the last line of a settled file). Use ONLY when the file is known to be
   * at rest, so a half-written record isn't emitted early then re-read. Returns
   * the buffered line, or undefined when the buffer is empty.
   */
  drainPartial(): string | undefined {
    if (!this.partial) return undefined;
    const line = this.partial;
    this.partial = "";
    return line;
  }
}
