// High-level G2 session: discover both arms, connect, run the prelude,
// expose write helpers + a typed event stream, tear down cleanly.

import {
  connectArm,
  findBothArms,
  onFrame,
  onRender,
  sendFrames,
  ts,
  waitForAck,
} from "./ble";
import type { ArmHandles } from "./ble";
import { framePb, FLAG_REQUEST } from "./envelope";
import type { ParsedFrame } from "./envelope";
import { PRELUDE_F5872, PRELUDE_F5872_SEQ, PRELUDE_F5872_SID } from "./messages";
import { decodeAsyncEvent } from "./events";
import type { DecodedEvent } from "./events";

export interface G2SessionOptions {
  sendPrelude?: boolean;       // default true
  preludeTimeoutMs?: number;   // default 5000
  quiet?: boolean;             // suppress info logs
}

export class G2Session {
  readonly left: ArmHandles;
  readonly right: ArmHandles;
  private transportSeq = 0x40;
  private quiet: boolean;

  private constructor(left: ArmHandles, right: ArmHandles, quiet: boolean) {
    this.left = left;
    this.right = right;
    this.quiet = quiet;
  }

  static async open(opts: G2SessionOptions = {}): Promise<G2Session> {
    const quiet = opts.quiet ?? false;
    if (!quiet) console.log(`[${ts()}] g2-session: scanning`);
    const { L, R } = await findBothArms();
    const right = await connectArm(R, "R", "R");
    const left = await connectArm(L, "L", "L");
    if (!quiet) console.log(`[${ts()}] g2-session: connected, settling 800ms`);
    await new Promise((r) => setTimeout(r, 800));

    const session = new G2Session(left, right, quiet);

    if (opts.sendPrelude ?? true) {
      if (!quiet) console.log(`[${ts()}] g2-session: prelude f5872`);
      const ack = waitForAck(right, PRELUDE_F5872_SID, PRELUDE_F5872_SEQ, opts.preludeTimeoutMs ?? 5000);
      await right.write.writeAsync(Buffer.from(PRELUDE_F5872), true);
      if (!(await ack)) throw new Error("g2-session: prelude ack timeout");
    }

    return session;
  }

  // Send a pb payload on sid/flag, wait for the ack that carries the
  // given magic in its f2 msgSeq. Returns the ack frame or null on timeout.
  async sendPb(
    sid: number,
    pb: Uint8Array,
    magic: number,
    opts: { flag?: number; ackTimeoutMs?: number; arm?: "L" | "R" } = {},
  ): Promise<ParsedFrame | null> {
    const flag = opts.flag ?? FLAG_REQUEST;
    const arm = (opts.arm ?? "R") === "R" ? this.right : this.left;
    const seq = this.transportSeq;
    this.transportSeq = (this.transportSeq + 1) & 0xff;
    const frames = framePb(pb, { seq, sid, flag });
    const ackP = waitForAck(arm, sid, magic, opts.ackTimeoutMs ?? 5000);
    await sendFrames(arm, frames);
    return ackP;
  }

  // Pipelined variant: register the ack waiter and write the frames,
  // but do NOT await the ack. Returns the pending ack promise as a
  // bare Promise (wrapped in an object to defeat the async-return auto-
  // unwrap). Caller drives a sliding window: fire a batch, then await
  // the oldest ack before firing another. Use this for high-rate image
  // streaming where blind fire-and-forget overruns the firmware — the
  // window provides natural backpressure without paying a full round
  // trip per fragment.
  async sendPbPipelined(
    sid: number,
    pb: Uint8Array,
    magic: number,
    opts: { flag?: number; ackTimeoutMs?: number; arm?: "L" | "R" } = {},
  ): Promise<{ ack: Promise<ParsedFrame | null> }> {
    const flag = opts.flag ?? FLAG_REQUEST;
    const arm = (opts.arm ?? "R") === "R" ? this.right : this.left;
    const seq = this.transportSeq;
    this.transportSeq = (this.transportSeq + 1) & 0xff;
    const frames = framePb(pb, { seq, sid, flag });
    const ackP = waitForAck(arm, sid, magic, opts.ackTimeoutMs ?? 5000);
    await sendFrames(arm, frames);
    return { ack: ackP };
  }

  // Subscribe to decoded async events from the right arm (L never emits
  // spontaneous traffic). Returns an unsubscribe function.
  onEvent(fn: (ev: DecodedEvent, frame: ParsedFrame) => void): () => void {
    return onFrame(this.right, (frame) => {
      if (!frame.ok) return;
      if (frame.flag !== 0x01 && frame.flag !== 0x06) return;
      const ev = decodeAsyncEvent(frame.sid, frame.flag, frame.pb);
      fn(ev, frame);
    });
  }

  // Raw frame subscription — both arms. Useful for debugging.
  onRawFrame(fn: (frame: ParsedFrame, raw: Uint8Array, arm: "L" | "R") => void): () => void {
    const offL = onFrame(this.left, (f, r) => fn(f, r, "L"));
    const offR = onFrame(this.right, (f, r) => fn(f, r, "R"));
    return () => { offL(); offR(); };
  }

  // Render-channel (6402) raw payload subscription. Used by audio capture —
  // LC3 packets arrive on the L arm once AudioCtrCmd is enabled.
  onRender(fn: (data: Uint8Array, arm: "L" | "R") => void): () => void {
    const offL = onRender(this.left, (d) => fn(d, "L"));
    const offR = onRender(this.right, (d) => fn(d, "R"));
    return () => { offL(); offR(); };
  }

  async close(): Promise<void> {
    if (!this.quiet) console.log(`[${ts()}] g2-session: disconnecting`);
    await this.right.peripheral.disconnectAsync().catch(() => {});
    await this.left.peripheral.disconnectAsync().catch(() => {});
  }
}
