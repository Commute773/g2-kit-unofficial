// Streaming LC3 → PCM decoder for G2 mic audio.
//
// Wraps Google's reference liblc3 (Homebrew: /opt/homebrew/lib/liblc3.dylib)
// via Bun's FFI. The G2 glasses stream mic audio as 205-byte BLE packets on
// the L arm's render_notify (6402) characteristic once AudioCtrCmd enables
// audio — see lib/audio.ts.
//
// G2 audio packet layout (205 bytes total, ~50 ms of audio):
//   bytes   0..199 : five 40-byte LC3 frames, 10 ms each at 16 kHz mono
//                    (32 kbps voice config — matches lc3_frame_bytes(10000,32000))
//   bytes 200..204 : 5-byte trailer. Byte 204 is a monotonic packet counter
//                    modulo 256; the rest is not yet reversed. Ignored for
//                    decoding.
//
// The LC3 params (dt=10ms, sr=16 kHz, mono) are lifted from decodeLc3 in the
// Flutter AOT decompile (flutter_ezw_lc3/lc3_codec.dart) and cross-checked
// against the empirically observed ~32.8 kbps on-air rate.
//
// Usage:
//
//   import { G2AudioDecoder } from "./lib";
//
//   const dec = new G2AudioDecoder();
//   const cap = new AudioCapture(session);
//   cap.onPacket((pkt) => {
//     const pcm = dec.decodePacket(pkt.data);  // 800 Int16 samples, 50 ms
//     // pcm is a view into an internal reusable buffer — COPY if you need
//     // it past the next decodePacket() call.
//   });
//   await cap.start();

import { dlopen, FFIType, type Pointer } from "bun:ffi";

const LIBLC3_PATH = "/opt/homebrew/lib/liblc3.dylib";

const { symbols: lc3 } = dlopen(LIBLC3_PATH, {
  lc3_decoder_size: {
    args: [FFIType.i32, FFIType.i32],
    returns: FFIType.u32,
  },
  lc3_setup_decoder: {
    args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr],
    returns: FFIType.ptr,
  },
  lc3_decode: {
    args: [
      FFIType.ptr, // decoder handle
      FFIType.ptr, // in bytes (or null for PLC)
      FFIType.i32, // in nbytes
      FFIType.i32, // pcm format enum
      FFIType.ptr, // pcm out
      FFIType.i32, // stride
    ],
    returns: FFIType.i32,
  },
  lc3_frame_samples: {
    args: [FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
});

// enum lc3_pcm_format from lc3.h
export const LC3_PCM_FORMAT_S16 = 0;
export const LC3_PCM_FORMAT_S24 = 1;
export const LC3_PCM_FORMAT_S24_3LE = 2;
export const LC3_PCM_FORMAT_FLOAT = 3;

// G2 mic config — confirmed from Flutter AOT decompile.
export const LC3_DT_US = 10_000;
export const LC3_SR_HZ = 16_000;
export const LC3_FRAME_BYTES = 40;       // 32 kbps at 10 ms / 16 kHz mono
export const LC3_FRAME_SAMPLES = 160;    // 10 ms @ 16 kHz

// G2 BLE packet structure (see module header).
export const G2_PACKET_BYTES = 205;
export const G2_LC3_PAYLOAD_BYTES = 200;
export const G2_FRAMES_PER_PACKET = 5;
export const G2_SAMPLES_PER_PACKET = G2_FRAMES_PER_PACKET * LC3_FRAME_SAMPLES; // 800
/** Offset of the monotonic mod-256 packet counter in each G2 audio packet. */
export const G2_COUNTER_OFFSET = 204;

export interface Lc3DecoderOptions {
  /** Frame duration in µs. Default 10000 (10 ms). */
  dtUs?: number;
  /** Encoded sample rate in Hz. Default 16000. */
  srHz?: number;
  /** Expected encoded frame size in bytes. Default 40. Used for validation. */
  frameBytes?: number;
}

/**
 * Single-frame LC3 decoder. One instance decodes one mono stream and keeps
 * internal state across frames, so do not reuse across independent streams.
 */
export class Lc3Decoder {
  private mem: Uint8Array;
  private handle: Pointer;
  private readonly dtUs: number;
  private readonly srHz: number;
  readonly frameBytes: number;
  readonly frameSamples: number;
  private closed = false;

  constructor(opts: Lc3DecoderOptions = {}) {
    this.dtUs = opts.dtUs ?? LC3_DT_US;
    this.srHz = opts.srHz ?? LC3_SR_HZ;
    this.frameBytes = opts.frameBytes ?? LC3_FRAME_BYTES;

    const samples = lc3.lc3_frame_samples(this.dtUs, this.srHz);
    if (samples < 0) {
      throw new Error(`Lc3Decoder: lc3_frame_samples(${this.dtUs}, ${this.srHz}) rejected`);
    }
    this.frameSamples = samples;

    const memSize = lc3.lc3_decoder_size(this.dtUs, this.srHz);
    if (memSize === 0) {
      throw new Error(`Lc3Decoder: lc3_decoder_size(${this.dtUs}, ${this.srHz}) rejected`);
    }
    // liblc3 requires pointer-aligned memory. A fresh Uint8Array is backed
    // by an ArrayBuffer whose base address is malloc-aligned (16 bytes on
    // darwin/arm64), which comfortably exceeds the 8-byte pointer alignment
    // liblc3 asks for.
    this.mem = new Uint8Array(Number(memSize));

    const h = lc3.lc3_setup_decoder(this.dtUs, this.srHz, 0, this.mem);
    if (!h) throw new Error("Lc3Decoder: lc3_setup_decoder returned null");
    this.handle = h;
  }

  /**
   * Decode one LC3 frame into Int16 PCM. If `pcmOut` is supplied it must hold
   * at least `frameSamples` samples and will be written in place; otherwise a
   * fresh Int16Array is allocated. Returns a view of exactly `frameSamples`
   * samples.
   */
  decodeFrame(lc3Bytes: Uint8Array, pcmOut?: Int16Array): Int16Array {
    if (this.closed) throw new Error("Lc3Decoder: closed");
    if (lc3Bytes.length !== this.frameBytes) {
      throw new Error(
        `Lc3Decoder.decodeFrame: expected ${this.frameBytes}B frame, got ${lc3Bytes.length}B`,
      );
    }
    const out = pcmOut ?? new Int16Array(this.frameSamples);
    if (out.length < this.frameSamples) {
      throw new Error(`Lc3Decoder.decodeFrame: pcmOut too small (${out.length} < ${this.frameSamples})`);
    }
    const rc = lc3.lc3_decode(
      this.handle,
      lc3Bytes,
      lc3Bytes.length,
      LC3_PCM_FORMAT_S16,
      out,
      1,
    );
    if (rc < 0) throw new Error("Lc3Decoder.decodeFrame: lc3_decode rejected params");
    // rc === 1 means PLC ran (bitstream bad, concealment emitted). Still a
    // valid audio frame to consume.
    return out.subarray(0, this.frameSamples);
  }

  /**
   * Run packet-loss concealment for one missing frame. Emits `frameSamples`
   * of synthesized PCM that maintains decoder state continuity.
   */
  decodePlc(pcmOut?: Int16Array): Int16Array {
    if (this.closed) throw new Error("Lc3Decoder: closed");
    const out = pcmOut ?? new Int16Array(this.frameSamples);
    const rc = lc3.lc3_decode(
      this.handle,
      null,
      0,
      LC3_PCM_FORMAT_S16,
      out,
      1,
    );
    if (rc < 0) throw new Error("Lc3Decoder.decodePlc: lc3_decode rejected params");
    return out.subarray(0, this.frameSamples);
  }

  close(): void {
    // liblc3 is static-allocation only; dropping the mem reference is
    // sufficient. Mark closed to catch use-after-free bugs in TS land.
    this.closed = true;
  }
}

export interface G2AudioDecoderOptions extends Lc3DecoderOptions {
  /**
   * Maximum number of missing packets to conceal with PLC before declaring a
   * resync. Beyond this the decoder jumps forward without emitting concealed
   * audio, which keeps downstream timing sane at the cost of a discontinuity.
   * Default 8 packets (400 ms).
   */
  maxPlcPackets?: number;
}

export type G2AudioChunkKind = "real" | "plc";

export interface G2StreamStats {
  /** Packets successfully decoded from real bitstream. */
  realPackets: number;
  /** Packets concealed (PLC) because of detected gaps. */
  plcPackets: number;
  /** Duplicate packets dropped (same counter as the previous one). */
  duplicatePackets: number;
  /** Resync events: gap > maxPlcPackets, packets silently skipped past. */
  resyncEvents: number;
  /** Packets skipped over during resyncs (not concealed). */
  skippedPackets: number;
}

/**
 * Convenience decoder for G2 audio packets. One 205-byte BLE packet in,
 * 800 Int16 PCM samples (50 ms at 16 kHz mono) out. The returned Int16Array
 * is a view into an internal reusable buffer — copy it if you need it past
 * the next call.
 *
 * For live/streaming use, call `feed(pkt, onChunk)` instead of
 * `decodePacket()`. `feed` reads the mod-256 counter at byte 204, detects
 * missing packets, and emits PLC-concealed chunks before the real one so the
 * LC3 decoder state stays coherent and downstream consumers (e.g. streaming
 * ASR) never see a timing jump for small losses.
 */
export class G2AudioDecoder {
  private readonly lc3: Lc3Decoder;
  private readonly pcmBuf = new Int16Array(G2_SAMPLES_PER_PACKET);
  private readonly maxPlcPackets: number;
  private lastCounter = -1;
  private readonly stats: G2StreamStats = {
    realPackets: 0,
    plcPackets: 0,
    duplicatePackets: 0,
    resyncEvents: 0,
    skippedPackets: 0,
  };

  constructor(opts: G2AudioDecoderOptions = {}) {
    this.lc3 = new Lc3Decoder(opts);
    this.maxPlcPackets = opts.maxPlcPackets ?? 8;
    if (this.lc3.frameSamples !== LC3_FRAME_SAMPLES) {
      throw new Error(
        `G2AudioDecoder: unexpected frameSamples ${this.lc3.frameSamples}, expected ${LC3_FRAME_SAMPLES}`,
      );
    }
    if (this.lc3.frameBytes !== LC3_FRAME_BYTES) {
      throw new Error(
        `G2AudioDecoder: unexpected frameBytes ${this.lc3.frameBytes}, expected ${LC3_FRAME_BYTES}`,
      );
    }
  }

  get samplesPerPacket(): number { return G2_SAMPLES_PER_PACKET; }
  get sampleRate(): number { return LC3_SR_HZ; }
  getStats(): Readonly<G2StreamStats> { return this.stats; }
  resetGapTracking(): void { this.lastCounter = -1; }

  decodePacket(packet: Uint8Array): Int16Array {
    if (packet.length !== G2_PACKET_BYTES) {
      throw new Error(
        `G2AudioDecoder.decodePacket: expected ${G2_PACKET_BYTES}B, got ${packet.length}B`,
      );
    }
    for (let i = 0; i < G2_FRAMES_PER_PACKET; i++) {
      const frame = packet.subarray(i * LC3_FRAME_BYTES, (i + 1) * LC3_FRAME_BYTES);
      const pcmView = this.pcmBuf.subarray(
        i * LC3_FRAME_SAMPLES,
        (i + 1) * LC3_FRAME_SAMPLES,
      );
      this.lc3.decodeFrame(frame, pcmView);
    }
    return this.pcmBuf;
  }

  /** Emit one packet-worth of PLC audio (5 concealed frames). */
  decodePlcPacket(): Int16Array {
    for (let i = 0; i < G2_FRAMES_PER_PACKET; i++) {
      const pcmView = this.pcmBuf.subarray(
        i * LC3_FRAME_SAMPLES,
        (i + 1) * LC3_FRAME_SAMPLES,
      );
      this.lc3.decodePlc(pcmView);
    }
    return this.pcmBuf;
  }

  /**
   * Feed one BLE audio packet into the streaming pipeline. Reads the mod-256
   * counter at byte 204, detects gaps against the previous packet, emits
   * PLC-concealed chunks for missing packets (up to `maxPlcPackets`), then
   * emits the decoded real chunk. Each `onChunk` call receives a view into
   * the internal reusable buffer; copy it if you need it past the next call
   * (including past the next PLC emission within this same feed()).
   *
   * Duplicate packets (same counter as previous) are dropped silently. Gaps
   * larger than `maxPlcPackets` are treated as resyncs: the decoder jumps
   * forward without emitting concealment, preserving downstream timing at
   * the cost of a brief audible discontinuity.
   */
  feed(
    packet: Uint8Array,
    onChunk: (pcm: Int16Array, kind: G2AudioChunkKind) => void,
  ): void {
    if (packet.length !== G2_PACKET_BYTES) {
      throw new Error(
        `G2AudioDecoder.feed: expected ${G2_PACKET_BYTES}B, got ${packet.length}B`,
      );
    }
    const counter = packet[G2_COUNTER_OFFSET]!;

    if (this.lastCounter >= 0) {
      const gap = (counter - this.lastCounter) & 0xff;
      if (gap === 0) {
        this.stats.duplicatePackets++;
        return;
      }
      const missing = gap - 1;
      if (missing > 0 && missing <= this.maxPlcPackets) {
        for (let i = 0; i < missing; i++) {
          this.decodePlcPacket();
          this.stats.plcPackets++;
          onChunk(this.pcmBuf, "plc");
        }
      } else if (missing > this.maxPlcPackets) {
        this.stats.resyncEvents++;
        this.stats.skippedPackets += missing;
      }
    }

    this.decodePacket(packet);
    this.stats.realPackets++;
    this.lastCounter = counter;
    onChunk(this.pcmBuf, "real");
  }

  close(): void { this.lc3.close(); }
}
