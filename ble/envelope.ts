// EvenHub BLE transport envelope.
//
// TX frame (phone -> glasses): aa 21 <seq> <len> <totFrags> <fragIdx> <sid> <flag> <pb...> [crcLE on last frag]
// RX frame (glasses -> phone): aa 12 ...same envelope layout...
//
// The CRC16/CCITT-FALSE is computed over the concatenated pb payload of all
// fragments and appended little-endian to the LAST fragment only.

import { crcBytesLE } from "./crc";

// Pre-reassembly varint peek — we only need Cmd + MagicRandom from the
// leading two fields of an EvenHub wrapper for ack matching, and we can't
// use protobuf-es here because mid-fragment payloads aren't valid messages.
function decodeVarint(b: Uint8Array, off: number): [number, number] {
  let v = 0, s = 0, i = off;
  while (i < b.length) {
    const c = b[i++]!;
    v |= (c & 0x7f) << s;
    if ((c & 0x80) === 0) return [v >>> 0, i];
    s += 7;
  }
  return [v >>> 0, i];
}

export const SYNC_TX = [0xaa, 0x21] as const;
export const SYNC_RX = [0xaa, 0x12] as const;

export const FLAG_REQUEST = 0x20;
export const FLAG_RESPONSE = 0x00;
export const FLAG_NOTIFY = 0x01;
export const FLAG_NOTIFY_ALT = 0x06;

// Subsystem IDs observed in the protocol.
export const SID = {
  APP: 0x01,          // app-launch handshake + widget-input touch events
  NOTIFY_APP: 0x09,   // firmware status / version telemetry
  STATE_CHANGE: 0x0d, // firmware->app "subsystem X state changed" bus
  WIDGET_XFORM: 0x0e, // widget transform channel
  HEARTBEAT: 0x80,    // heartbeat + settings queries
  NOTIF_PAYLOAD: 0xc5, // Android notification JSON payload
  EVENHUB: 0xe0,      // main container/image/text subsystem
} as const;

export interface FrameOptions {
  seq: number;
  sid: number;
  flag: number;
  chunkSize?: number; // default 232 — matches Mirai's transport fragmentation
}

// Split a pb payload into fragmented BLE frames with CRC on the last frag.
export function framePb(pb: Uint8Array, opts: FrameOptions): Uint8Array[] {
  const chunkSize = opts.chunkSize ?? 232;
  const crc = crcBytesLE(pb);
  const totalWithCrc = pb.length + 2;
  const totalFrags = Math.max(1, Math.ceil(totalWithCrc / chunkSize));
  const frames: Uint8Array[] = [];
  let off = 0;
  for (let i = 0; i < totalFrags; i++) {
    const isLast = i === totalFrags - 1;
    let chunk: Uint8Array;
    if (isLast) {
      const remain = pb.subarray(off);
      chunk = new Uint8Array(remain.length + 2);
      chunk.set(remain, 0);
      chunk.set(crc, remain.length);
      off += remain.length;
    } else {
      chunk = pb.subarray(off, off + chunkSize);
      off += chunkSize;
    }
    const frame = new Uint8Array(8 + chunk.length);
    frame[0] = SYNC_TX[0];
    frame[1] = SYNC_TX[1];
    // All fragments of a single message share the same transport seq
    // byte — firmware uses it as the reassembly group key. Incrementing
    // per-fragment (as we used to) causes the firmware to see an
    // orphaned frag 2/N with no matching frag 1, silently drop the
    // whole message, and emit an 8-byte abort frame on sid=0xe0 flag=02.
    frame[2] = opts.seq & 0xff;
    frame[3] = chunk.length;
    frame[4] = totalFrags;
    frame[5] = i + 1;
    frame[6] = opts.sid;
    frame[7] = opts.flag;
    frame.set(chunk, 8);
    frames.push(frame);
  }
  return frames;
}

export interface ParsedFrame {
  ok: boolean;
  isTx: boolean; // true if aa21, false if aa12
  transportSeq: number;
  len: number;
  totalFrags: number;
  fragIdx: number;
  sid: number;
  flag: number;
  pb: Uint8Array;
  // Decoded scalar fields from the outer pb header: EvenHub wraps messages
  // as { f1 = msgType/Cmd, f2 = msgSeq/magic, ... }. Parsed lazily from the
  // pb payload when available.
  msgType?: number;
  msgSeq?: number;
}

export function parseFrame(buf: Uint8Array): ParsedFrame {
  if (buf.length < 10 || buf[0] !== 0xaa || (buf[1] !== 0x21 && buf[1] !== 0x12)) {
    return {
      ok: false, isTx: false, transportSeq: 0, len: 0, totalFrags: 0, fragIdx: 0,
      sid: 0, flag: 0, pb: new Uint8Array(0),
    };
  }
  const isTx = buf[1] === 0x21;
  const transportSeq = buf[2]!;
  const len = buf[3]!;
  const totalFrags = buf[4]!;
  const fragIdx = buf[5]!;
  const sid = buf[6]!;
  const flag = buf[7]!;
  // pb content length = len - 2(crc) on last frag, len on mid frags. We
  // don't know which frag this is without reassembly, so we return the raw
  // chunk between envelope and any trailing CRC — callers that just need
  // sid/seq for ack matching can ignore the tail.
  const pb = buf.subarray(8, Math.min(buf.length, 6 + len));

  // Try to peel f1 (msgType) and f2 (msgSeq/magic) out of the first two
  // varint fields — this is the shape of every EvenHub wrapper we've seen.
  let msgType: number | undefined;
  let msgSeq: number | undefined;
  {
    let off = 0;
    for (let k = 0; k < 8 && off < pb.length; k++) {
      const key = pb[off++]!;
      const tag = key >> 3;
      const wire = key & 7;
      if (wire === 0) {
        const [v, n] = decodeVarint(pb, off);
        if (tag === 1) msgType = v;
        else if (tag === 2) msgSeq = v;
        off = n;
      } else if (wire === 2) {
        const [lb, n] = decodeVarint(pb, off);
        off = n + lb;
      } else break;
      if (msgType !== undefined && msgSeq !== undefined) break;
    }
  }

  return {
    ok: true, isTx, transportSeq, len, totalFrags, fragIdx,
    sid, flag, pb, msgType, msgSeq,
  };
}
