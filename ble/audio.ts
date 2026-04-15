// G2 mic audio capture.
//
// Protocol summary (reversed from the Even SDK Flutter AOT, 2026-04-14):
//
//   1. Create at least one StartUpPage container — the firmware rejects
//      AudioCtrCmd until there's an active "page" on screen. Any
//      container satisfies the precondition.
//   2. Send EvenHub Cmd=18 APP_REQUEST_AUDIO_CTR_PACKET with
//      AudioCtrCommand { AudoFuncEn: 1 }. Glasses ack with Cmd=19
//      OS_RESPONSE_AUDIO_CTR_PACKET carrying AudioResCommand.AudioStat=1.
//   3. Raw LC3 packets immediately start arriving on the LEFT arm's
//      render_notify (6402) characteristic. Each BLE notification is
//      205 bytes and represents ~50 ms of audio (five 10 ms LC3 frames
//      at 16 kHz, ~32 kbps voice config — see the `LC3_*` constants
//      below).
//   4. To stop, send AudioCtrCmd { AudoFuncEn: 0 }.
//
// The 205-byte payload has no envelope header — it is NOT a parseFrame
// input. Consumers receive it as raw bytes via AudioCapture.onPacket()
// and either persist it for offline LC3 decoding or pipe it into an
// online decoder.

import { create, toBinary } from "@bufbuild/protobuf";
import {
  evenhub_main_msg_ctxSchema,
  EvenHub_Cmd_List,
} from "./gen/EvenHub_pb";
import type { G2SessionLike } from "./session";

const SID_EVENHUB = 0xe0;

// LC3 config used by the G2 firmware. Lifted from decodeLc3 in
// flutter_ezw_lc3/lc3_codec.dart (Blutter output):
//   0x3e80 = 16000  → sample rate 16 kHz
//   0x2710 = 10000  → frame duration 10 000 µs (10 ms)
// Channel count is 1 (mono mic).
export const LC3_SAMPLE_RATE = 16000;
export const LC3_FRAME_US = 10000;
export const LC3_CHANNELS = 1;

// Empirically observed (2026-04-14): every BLE notification on the L
// arm's 6402 char is exactly 205 bytes and they arrive at ~20 pps,
// yielding ≈32.8 kbps — matches a LC3 voice config of 5× 40-byte frames
// per packet (200 bytes of LC3 audio + a 5-byte packet header, most
// likely, though the header structure isn't confirmed yet).
export const AUDIO_PACKET_BYTES = 205;
export const AUDIO_PACKETS_PER_SEC = 20;

export interface AudioPacket {
  /** Raw bytes as delivered by BLE. Not envelope-framed. */
  data: Uint8Array;
  /** Arm that delivered the packet. In practice always "L" for mic audio. */
  arm: "L" | "R";
  /** Date.now() at arrival. */
  arrivalMs: number;
}

function buildAudioCtrCmd(enable: boolean, magic: number): Uint8Array {
  const msg = create(evenhub_main_msg_ctxSchema, {
    Cmd: EvenHub_Cmd_List.APP_REQUEST_AUDIO_CTR_PACKET,
    MagicRandom: magic,
    AudioCtrCommand: { AudoFuncEn: enable ? 1 : 0 },
  });
  return toBinary(evenhub_main_msg_ctxSchema, msg);
}

export interface AudioCaptureOptions {
  /** ACK timeout for the enable/disable AudioCtrCmd, in ms. */
  ackTimeoutMs?: number;
}

/**
 * Capture raw LC3 mic audio from the G2 glasses.
 *
 * Usage:
 *
 *   const cap = new AudioCapture(session);
 *   cap.onPacket((pkt) => fs.writeSync(fd, pkt.data));
 *   await cap.start();
 *   // ...some time later...
 *   await cap.stop();
 *
 * The caller is responsible for having created at least one StartUpPage
 * container before calling start() (see buildCreateStartUpPageContainer
 * in ./messages.ts).
 */
export class AudioCapture {
  private session: G2SessionLike;
  private listeners = new Set<(pkt: AudioPacket) => void>();
  private offRender: (() => void) | null = null;
  private running = false;

  constructor(session: G2SessionLike) {
    this.session = session;
  }

  get isRunning(): boolean {
    return this.running;
  }

  onPacket(fn: (pkt: AudioPacket) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  async start(opts: AudioCaptureOptions = {}): Promise<void> {
    if (this.running) return;

    this.offRender = this.session.onRender((data, arm) => {
      const pkt: AudioPacket = { data, arm, arrivalMs: Date.now() };
      for (const fn of this.listeners) {
        try { fn(pkt); } catch (e) { console.error("AudioCapture listener", e); }
      }
    });

    const magic = 0xa1;
    const pb = buildAudioCtrCmd(true, magic);
    const ack = await this.session.sendPb(SID_EVENHUB, pb, magic, {
      ackTimeoutMs: opts.ackTimeoutMs ?? 3000,
    });
    if (!ack) {
      this.offRender?.();
      this.offRender = null;
      throw new Error("AudioCapture.start: AudioCtrCmd enable had no ack");
    }
    this.running = true;
  }

  async stop(opts: AudioCaptureOptions = {}): Promise<void> {
    if (!this.running) return;
    this.running = false;

    const magic = 0xa2;
    const pb = buildAudioCtrCmd(false, magic);
    await this.session.sendPb(SID_EVENHUB, pb, magic, {
      ackTimeoutMs: opts.ackTimeoutMs ?? 1500,
    }).catch(() => { /* best effort */ });

    this.offRender?.();
    this.offRender = null;
    this.listeners.clear();
  }
}
