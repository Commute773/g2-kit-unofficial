// BLE packet helpers for the Even Realities R1 smart ring.
//
// The ring is a separate BLE peripheral advertising under names like
// `EVEN R1_<last-3-MAC-bytes>` (e.g. `EVEN R1_508B74`). Its primary service
// exposes two pairs of write+notify characteristics; all traffic observed
// from the official `com.even.sg` app uses the second pair (bae80012 /
// bae80013) — the first pair (bae80010 / bae80011) is unused or reserved.
//
// Unlike the G2 glasses (which speak `aa 12`-framed protobuf), the ring
// uses a compact binary frame:
//
//   [0]     = 0x00 frame marker
//   [1..4]  = 4-byte session hash (random per-packet, anti-replay;
//             the ring silently drops writes that replay a hash it's
//             recently accepted)
//   [5]     = 0x64 marker
//   [6]     = seq group (0x01 or 0x02; 0x01 is the default, 0x02 is used
//             for a small set of commands that need group-addressed replies)
//   [7]     = 0x64 marker
//   [8]     = sequence number (u8, increments per write within a session)
//   [9..10] = flags (u16 BE)  0x0000=req, 0x0001=set, 0x0002=push,
//                             0x0003=response
//   [11]    = 0x00 spacer
//   [12]    = cmd byte (BleRing1Cmd enum on wire)
//   [13]    = sub byte (BleRing1SubCmd via firmware lookup table — NOT the
//             raw enum ordinal; e.g. pairAuth maps to 0x0d, getAlgoKey to
//             0x0c, responses to 0x18/0x25 depending on command)
//   [14]    = 0x00 spacer
//   [15..]  = payload (variable length, NO trailing CRC)
//
// Verified against HCI snoop captures of the real `com.even.sg` app on
// 2026-04-13 and 2026-04-16 (see `~/g2-re/captures/` and
// `~/.claude/projects/-Users-elinaro/memory/project_r1_ring_protocol.md`).

// ---------- BLE service / characteristic UUIDs ----------

export const R1_SERVICE_UUID = "bae80001-4f05-4503-8e65-3af1f7329d1f";
export const R1_WRITE_CHAR_UUID = "bae80012-4f05-4503-8e65-3af1f7329d1f";
export const R1_NOTIFY_CHAR_UUID = "bae80013-4f05-4503-8e65-3af1f7329d1f";

// Ring advertisement regex. The manufacturer-data blob begins with 0x45 0x52
// ("ER" = Even Realities) and carries the MAC reversed; for scanning by name:
export const R1_NAME_RE = /^EVEN\s+R1_([0-9A-F]{6})$/i;

// ---------- Cmd / flag constants ----------

export const R1_CMD = {
  system: 0x00,
  heartRate: 0x01,
  spo2: 0x02,
  temperature: 0x03,
  hrv: 0x04,
  activity: 0x05,
  sleep: 0x06,
  sportRunCtrl: 0x07,
  sportRunData: 0x08,
  healthSetting: 0x09,
  // The following cmd codes don't appear in the `BleRing1Cmd` Dart enum
  // (which stops at 0x09) but are observed on the wire during the normal
  // app pair sequence. Likely internal/undocumented subsystems:
  linkToGlasses: 0x0a,       // pair/bind with G2 glasses (sub=0x12)
  algoKey: 0x0b,             // get current session key (sub=0x0c req, 0x25 resp)
  config1: 0x0e,             // config readout (sub=0x0c req, 0x18 resp)
  config2: 0x0f,             // second config readout (sub=0x0c req, 0x18 resp)
  serial: 0x11,              // serial-number async push (sub=0x85)
  phoneStatus: 0x7e,         // phone→ring status push (sub=0x16, flags=0x0001)
  phoneStatusAck: 0x7f,      // ring's ack for phoneStatus (sub=0x13)
} as const;

export const R1_FLAGS = {
  REQUEST: 0x0000,
  SET: 0x0001,
  PUSH: 0x0002,
  RESPONSE: 0x0003,
} as const;

// ---------- Low-level packet builder ----------

export interface RingPacketOptions {
  seq: number;                     // sequence number (0-255)
  flags?: number;                  // defaults to REQUEST (0x0000)
  seqGroup?: 0x01 | 0x02;          // defaults to 0x01
  cmd: number;
  sub: number;
  payload?: Uint8Array | Buffer;
  /**
   * 4-byte anti-replay hash placed at bytes [1..4]. Defaults to four
   * cryptographically random bytes, which the ring accepts silently. Only
   * override if you're replaying a captured packet verbatim — the ring
   * will disconnect within ~15s if it sees the same hash twice.
   */
  hash?: Uint8Array;
}

export function buildRingPacket(opts: RingPacketOptions): Uint8Array {
  const hash = opts.hash ?? randomHash();
  if (hash.length !== 4) {
    throw new Error(`ring packet hash must be 4 bytes, got ${hash.length}`);
  }
  const seqGroup = opts.seqGroup ?? 0x01;
  const flags = opts.flags ?? R1_FLAGS.REQUEST;
  const payload = opts.payload ?? new Uint8Array(0);
  const out = new Uint8Array(15 + payload.length);
  out[0] = 0x00;
  out.set(hash, 1);
  out[5] = 0x64;
  out[6] = seqGroup;
  out[7] = 0x64;
  out[8] = opts.seq & 0xff;
  out[9] = (flags >> 8) & 0xff;
  out[10] = flags & 0xff;
  out[11] = 0x00;
  out[12] = opts.cmd & 0xff;
  out[13] = opts.sub & 0xff;
  out[14] = 0x00;
  out.set(payload, 15);
  return out;
}

function randomHash(): Uint8Array {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return b;
}

// ---------- Packet parser ----------

export interface ParsedRingPacket {
  ok: boolean;
  hash: Uint8Array;
  seqGroup: number;
  seq: number;
  flags: number;
  cmd: number;
  sub: number;
  payload: Uint8Array;
}

export function parseRingPacket(buf: Uint8Array): ParsedRingPacket {
  if (buf.length < 15 || buf[0] !== 0x00 || buf[5] !== 0x64 || buf[7] !== 0x64) {
    return {
      ok: false,
      hash: new Uint8Array(0),
      seqGroup: 0, seq: 0, flags: 0, cmd: 0, sub: 0,
      payload: new Uint8Array(0),
    };
  }
  return {
    ok: true,
    hash: buf.subarray(1, 5),
    seqGroup: buf[6]!,
    seq: buf[8]!,
    flags: (buf[9]! << 8) | buf[10]!,
    cmd: buf[12]!,
    sub: buf[13]!,
    payload: buf.subarray(15),
  };
}

// ---------- High-level command builders ----------

/**
 * Build the `cmd=0x0a sub=0x12` command that binds the ring to a pair of
 * G2 glasses. Without this, ring taps/scrolls never relay to the phone —
 * the ring doesn't know which glasses to route events through.
 *
 * The official app sends this command TWICE in a row during its pair init
 * (immediately after pairAuth, config queries, and time sync), with
 * different random nonces each time. Observed in snoop captures; the
 * two-byte prefix is consumed as a freshness token.
 *
 * @param glassesMac  The G2 right-arm MAC in normal big-endian form,
 *                    e.g. "D4:5B:37:A7:A3:63". The left arm follows the
 *                    right on its own channel; only the right arm's MAC
 *                    goes into this command.
 * @param seq         Sequence number (0-255)
 * @param nonce       Optional 2-byte freshness prefix; defaults to random.
 */
export function buildLinkToGlasses(
  glassesMac: string,
  seq: number,
  nonce?: Uint8Array,
): Uint8Array {
  const macBytes = parseMac(glassesMac);
  const macReversed = macBytes.slice().reverse();
  const prefix = nonce ?? randomNonce2();
  if (prefix.length !== 2) {
    throw new Error(`nonce must be 2 bytes, got ${prefix.length}`);
  }
  const payload = new Uint8Array(8);
  payload.set(prefix, 0);
  payload.set(macReversed, 2);
  return buildRingPacket({
    seq,
    flags: R1_FLAGS.REQUEST,
    cmd: R1_CMD.linkToGlasses,
    sub: 0x12,
    payload,
  });
}

function randomNonce2(): Uint8Array {
  const b = new Uint8Array(2);
  crypto.getRandomValues(b);
  return b;
}

function parseMac(mac: string): Uint8Array {
  const hex = mac.replace(/[:\-]/g, "");
  if (hex.length !== 12) {
    throw new Error(`invalid MAC ${JSON.stringify(mac)} — expected 6 bytes`);
  }
  const out = new Uint8Array(6);
  for (let i = 0; i < 6; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Build the pairAuth init packet (`cmd=0x08 sub=0x0d`). The payload is
 * session-specific and normally derived from a challenge-response with
 * the ring's async push; replaying a captured init works exactly once
 * per ring power-cycle, after which the ring silently drops duplicates.
 *
 * For fresh sessions without a known derivation, replay a recent capture
 * and accept that subsequent commands may not work until the full pair
 * handshake completes (setAlgoKey with the server-issued pkey, see
 * `/v2/g/health/get_pkey` in `~/bletools/API.md`).
 */
export function buildPairAuthInit(seq: number, payload: Uint8Array): Uint8Array {
  return buildRingPacket({
    seq,
    flags: R1_FLAGS.REQUEST,
    cmd: R1_CMD.system,
    sub: 0x0d,
    payload,
  });
}

/**
 * Build a time-sync push to the ring. The ring uses this to timestamp
 * subsequent health samples (heart rate, activity, etc).
 *
 * Wire format observed: `b9 0e 10 ff` header followed by a u32 LE unix
 * timestamp. The header bytes appear to be static per firmware version —
 * this helper emits the same bytes the app does.
 *
 * @param seq      Sequence number (0-255)
 * @param unixSec  Unix epoch seconds, defaults to now.
 */
export function buildTimeSync(seq: number, unixSec?: number): Uint8Array {
  const ts = unixSec ?? Math.floor(Date.now() / 1000);
  const payload = new Uint8Array(8);
  payload[0] = 0xb9;
  payload[1] = 0x0e;
  payload[2] = 0x10;
  payload[3] = 0xff;
  payload[4] = ts & 0xff;
  payload[5] = (ts >>> 8) & 0xff;
  payload[6] = (ts >>> 16) & 0xff;
  payload[7] = (ts >>> 24) & 0xff;
  return buildRingPacket({
    seq,
    flags: R1_FLAGS.PUSH,
    cmd: R1_CMD.activity,  // 0x05
    sub: 0x12,
    payload,
  });
}

// Re-export the G2 sys-event decoder so consumers can pull ring-originated
// taps out of the glasses' NotifyApp channel without reaching into
// `events.ts` themselves. Ring taps arrive at the phone as:
//   glasses h=0x0844 → parseFrame → sid=0xe0 flag=0x01 → decodeAsyncEvent
//   → { kind:"sys-event", eventType, eventSource }
// with eventSource === EventSourceType.TOUCH_EVENT_FROM_RING (=2).
export { EventSourceType } from "./gen/EvenHub_pb";
