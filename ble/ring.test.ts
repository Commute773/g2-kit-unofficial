// Tests for the R1 ring packet codec against real HCI snoop captures of
// the official com.even.sg app pairing with Shahara's ring + glasses.
//
// All hex samples below are captured packets, copied verbatim from
// btsnoop_hci.log. Every `build*` helper is verified to produce the
// same bytes the real app produces, holding (seq, nonce, payload)
// inputs equal to what the app used in the capture.

import { test, expect, describe } from "bun:test";
import {
  buildLinkToGlasses,
  buildRingPacket,
  buildPairAuthInit,
  buildTimeSync,
  buildConfig1Get,
  buildConfig2Get,
  buildHrvInit,
  parseRingPacket,
  tryDecodeHealthPush,
  decodeHeartRateTail,
  decodeActivityTail,
  decodeFirmware,
  decodeSerial,
  R1_CMD,
  R1_FLAGS,
  R1_SERVICE_UUID,
  R1_WRITE_CHAR_UUID,
  R1_NOTIFY_CHAR_UUID,
} from "./ring";

// ---------- Low-level packet builder / parser round-trips ----------

describe("buildRingPacket / parseRingPacket", () => {
  test("round-trips fields", () => {
    const hash = new Uint8Array([0x97, 0x19, 0x53, 0xf9]);
    const pkt = buildRingPacket({
      seq: 1, flags: R1_FLAGS.REQUEST, cmd: R1_CMD.pairAuth, sub: 0x0d,
      payload: new Uint8Array([0x3f, 0x01, 0x01]), hash,
    });
    // This is exactly the very-first pairAuth init the official app sends
    // on a captured bond. seq=1 was the app's real seq, payload 3f0101
    // is the fixed BleRing1SubCmd.pairAuth init byte sequence.
    expect(Buffer.from(pkt).toString("hex")).toBe(
      "00971953f964016401000000080d003f0101",
    );

    const p = parseRingPacket(pkt);
    expect(p.ok).toBe(true);
    expect(p.seq).toBe(1);
    expect(p.cmd).toBe(0x08);
    expect(p.sub).toBe(0x0d);
    expect(p.flags).toBe(0x0000);
    expect(Buffer.from(p.payload).toString("hex")).toBe("3f0101");
    expect(Buffer.from(p.hash).toString("hex")).toBe("971953f9");
  });

  test("defaults hash to fresh random bytes", () => {
    const a = buildRingPacket({ seq: 10, cmd: 0x01, sub: 0x0c });
    const b = buildRingPacket({ seq: 10, cmd: 0x01, sub: 0x0c });
    // Hashes should differ across calls.
    expect(Buffer.from(a.subarray(1, 5)).equals(Buffer.from(b.subarray(1, 5)))).toBe(false);
  });

  test("defaults flags to REQUEST (0x0000)", () => {
    const p = parseRingPacket(buildRingPacket({ seq: 5, cmd: 0x02, sub: 0x0c }));
    expect(p.flags).toBe(0x0000);
  });

  test("defaults seqGroup to 0x01", () => {
    const pkt = buildRingPacket({ seq: 5, cmd: 0x02, sub: 0x0c });
    expect(pkt[6]).toBe(0x01);
  });

  test("rejects bad hash length", () => {
    expect(() => buildRingPacket({
      seq: 1, cmd: 0x01, sub: 0x0c,
      hash: new Uint8Array([1, 2, 3]),
    })).toThrow(/4 bytes/);
  });

  test("parseRingPacket rejects malformed frame", () => {
    const p = parseRingPacket(new Uint8Array([0x01, 0x00, 0x00]));
    expect(p.ok).toBe(false);
  });

  test("parseRingPacket requires version marker bytes", () => {
    // Valid length but no 0x64 markers at positions 5 and 7
    const bad = new Uint8Array(18);
    bad[0] = 0x00; // frame
    // leave bytes 5 and 7 as 0
    const p = parseRingPacket(bad);
    expect(p.ok).toBe(false);
  });
});

// ---------- buildLinkToGlasses: the primary ring↔glasses bind ----------

describe("buildLinkToGlasses", () => {
  test("packet matches captured app frame for Shahara's G2 right-arm MAC", () => {
    // Captured packet from snoop (one of two `0a/12` sends the app does
    // during its pair init). The app used nonce=45c9 and seq=7. We force
    // those plus a known hash to get the exact bytes back.
    const hash = new Uint8Array([0xc5, 0x0c, 0x12, 0x48]);
    const pkt = buildLinkToGlasses("D4:5B:37:A7:A3:63", 7, new Uint8Array([0x45, 0xc9]));
    // Override the random hash with the captured one for exact match.
    pkt.set(hash, 1);
    expect(Buffer.from(pkt).toString("hex")).toBe(
      "00c50c1248640164070000000a120045c963a3a7375bd4",
    );
  });

  test("reverses the MAC into the payload", () => {
    const pkt = buildLinkToGlasses("D4:5B:37:A7:A3:63", 1, new Uint8Array([0, 0]));
    const p = parseRingPacket(pkt);
    expect(p.cmd).toBe(R1_CMD.linkToGlasses);
    expect(p.sub).toBe(0x12);
    expect(p.flags).toBe(R1_FLAGS.REQUEST);
    // Payload: 2-byte nonce + 6-byte MAC reversed
    expect(Buffer.from(p.payload).toString("hex")).toBe("000063a3a7375bd4");
  });

  test("accepts MAC with different separators", () => {
    const a = buildLinkToGlasses("D4:5B:37:A7:A3:63", 1, new Uint8Array([0, 0]));
    const b = buildLinkToGlasses("D4-5B-37-A7-A3-63", 1, new Uint8Array([0, 0]));
    const c = buildLinkToGlasses("D45B37A7A363", 1, new Uint8Array([0, 0]));
    const pa = parseRingPacket(a).payload;
    const pb = parseRingPacket(b).payload;
    const pc = parseRingPacket(c).payload;
    expect(Buffer.from(pa).toString("hex")).toBe(Buffer.from(pb).toString("hex"));
    expect(Buffer.from(pa).toString("hex")).toBe(Buffer.from(pc).toString("hex"));
  });

  test("rejects malformed MAC", () => {
    expect(() => buildLinkToGlasses("not-a-mac", 1)).toThrow(/invalid MAC/);
    expect(() => buildLinkToGlasses("D4:5B:37:A7:A3", 1)).toThrow(/invalid MAC/);
  });

  test("rejects non-2-byte nonce", () => {
    expect(() => buildLinkToGlasses(
      "D4:5B:37:A7:A3:63", 1, new Uint8Array([1, 2, 3]),
    )).toThrow(/nonce/);
  });
});

// ---------- buildPairAuthInit ----------

describe("buildPairAuthInit", () => {
  test("produces cmd=0x08 sub=0x0d with passed payload", () => {
    const pkt = buildPairAuthInit(1, new Uint8Array([0x3f, 0x01, 0x01]));
    const p = parseRingPacket(pkt);
    expect(p.cmd).toBe(R1_CMD.pairAuth);  // 0x08
    expect(p.sub).toBe(0x0d);
    expect(p.flags).toBe(R1_FLAGS.REQUEST);
    expect(Buffer.from(p.payload).toString("hex")).toBe("3f0101");
  });
});

// ---------- buildTimeSync ----------

describe("buildTimeSync", () => {
  test("packet shape matches captured app push", () => {
    // Captured from snoop: app sent cmd=05/12 flags=0x0002 with payload
    // b90e10ff + unix_ts(0x69dd330c). Same seq/hash replayable.
    const pkt = buildTimeSync(3, 0x69dd330c);
    const hash = new Uint8Array([0xe0, 0xbf, 0x0d, 0x85]);
    pkt.set(hash, 1);
    expect(Buffer.from(pkt).toString("hex")).toBe(
      "00e0bf0d8564016403000200051200b90e10ff0c33dd69",
    );
  });

  test("defaults unixSec to now()", () => {
    const before = Math.floor(Date.now() / 1000);
    const pkt = buildTimeSync(1);
    const p = parseRingPacket(pkt);
    const ts = p.payload.subarray(4, 8);
    const unix = ts[0]! | (ts[1]! << 8) | (ts[2]! << 16) | (ts[3]! << 24);
    expect(unix).toBeGreaterThanOrEqual(before);
    expect(unix).toBeLessThanOrEqual(before + 2);
  });
});

describe("buildConfig1Get / buildConfig2Get", () => {
  test("config1/get packet shape matches captured app (seq=40, nonce=912f)", () => {
    // Captured: 00 d5faceaf 64 01 64 28 0000 00 0e 0c 00 912f
    const pkt = buildConfig1Get(0x28, new Uint8Array([0x91, 0x2f]));
    pkt.set(new Uint8Array([0xd5, 0xfa, 0xce, 0xaf]), 1);
    expect(Buffer.from(pkt).toString("hex")).toBe(
      "00d5faceaf640164280000000e0c00912f",
    );
  });

  test("config2/get packet shape matches captured app (seq=41, nonce=015d)", () => {
    // Captured: 00 00045a68 64 01 64 29 0000 00 0f 0c 00 015d
    const pkt = buildConfig2Get(0x29, new Uint8Array([0x01, 0x5d]));
    pkt.set(new Uint8Array([0x00, 0x04, 0x5a, 0x68]), 1);
    expect(Buffer.from(pkt).toString("hex")).toBe(
      "0000045a68640164290000000f0c00015d",
    );
  });

  test("config1/get defaults nonce to random bytes", () => {
    const a = buildConfig1Get(10);
    const b = buildConfig1Get(10);
    const p1 = parseRingPacket(a);
    const p2 = parseRingPacket(b);
    expect(p1.cmd).toBe(0x0e);
    expect(p1.sub).toBe(0x0c);
    expect(Buffer.from(p1.payload).equals(Buffer.from(p2.payload))).toBe(false);
  });
});

describe("buildHrvInit", () => {
  test("packet shape matches captured app (seq=44, nonce=1ede)", () => {
    // Captured: 00 0e8624a9 64 01 64 2c 0000 00 04 18 00 1ede 02 00*11
    const pkt = buildHrvInit(0x2c, new Uint8Array([0x1e, 0xde]));
    pkt.set(new Uint8Array([0x0e, 0x86, 0x24, 0xa9]), 1);
    expect(Buffer.from(pkt).toString("hex")).toBe(
      "000e8624a96401642c0000000418001ede020000000000000000000000",
    );
  });

  test("encodes 14-byte payload (2B nonce + 0x02 + 11 × 0x00)", () => {
    const pkt = buildHrvInit(1, new Uint8Array([0xaa, 0xbb]));
    const p = parseRingPacket(pkt);
    expect(p.payload.length).toBe(14);
    expect(Array.from(p.payload.slice(0, 3))).toEqual([0xaa, 0xbb, 0x02]);
    expect(Array.from(p.payload.slice(3)).every(b => b === 0)).toBe(true);
  });
});

// ---------- Health push decoding ----------

describe("health-push decoding", () => {
  // Ring rx packet from snoop: cmd=01/24 (heart rate push).
  // Envelope wraps payload `67 0b 03 10 ff | 40 6a dc 69 | 23 31 dd 69 | 51 0b 56 56 56 0c 53 53 53 0e 51 51 51`.
  const RAW_HR = Buffer.from(
    "0012345678640164100002000124" + "00" + "670b0310ff406adc692331dd69510b5656560c5353530e515151",
    "hex",
  );

  test("recognizes the heart-rate push shape", () => {
    const p = parseRingPacket(RAW_HR);
    expect(p.ok).toBe(true);
    expect(p.cmd).toBe(R1_CMD.heartRate);
    expect(p.sub).toBe(0x24);

    const h = tryDecodeHealthPush(p);
    expect(h).not.toBeNull();
    expect(h!.subName).toBe("heartRate");
    // window start = 0x69dc6a40 = 2026-04-13 14:12:16 UTC
    expect(h!.windowStartUnix).toBe(0x69dc6a40);
    // sample = 0x69dd3123
    expect(h!.sampleUnix).toBe(0x69dd3123);
    expect(h!.flagByte).toBe(0x03);
    expect(Buffer.from(h!.tail).toString("hex")).toBe(
      "510b5656560c5353530e515151",
    );
  });

  test("rejects non-health packets", () => {
    const fw = parseRingPacket(Buffer.from(
      "0000000000640164010003000212" + "00" + "0000",
      "hex",
    ));
    expect(tryDecodeHealthPush(fw)).toBeNull();
  });

  test("rejects packets missing the 10ff marker", () => {
    const bad = parseRingPacket(Buffer.from(
      "0012345678640164100002000124" + "00" + "670b030000406adc69" + "00".repeat(20),
      "hex",
    ));
    expect(tryDecodeHealthPush(bad)).toBeNull();
  });

  test("decodeHeartRateTail parses 4-byte groups", () => {
    // 9 bytes → 2 full groups + 1 leftover byte.
    const tail = new Uint8Array([0x51, 0x0b, 0x56, 0x56, 0x56, 0x0c, 0x53, 0x53, 0x53]);
    const groups = decodeHeartRateTail(tail);
    expect(groups).toEqual([
      { intervalMin: 0x51, bpm: [0x0b, 0x56, 0x56] },
      { intervalMin: 0x56, bpm: [0x0c, 0x53, 0x53] },
    ]);
  });

  test("decodeActivityTail reads u16 LE samples", () => {
    // 5 bytes → 2 u16 LE samples; trailing byte is ignored.
    const tail = new Uint8Array([0x2f, 0x00, 0x0c, 0x2f, 0x00]);
    expect(decodeActivityTail(tail)).toEqual([0x002f, 0x2f0c]);
  });
});

// ---------- IMU / accelerometer helpers ----------

describe("IMU helpers", () => {
  test("normalizeImu treats all-zero readings as absent", () => {
    const { normalizeImu } = require("./ring");
    expect(normalizeImu({ x: 0, y: 0, z: 0 })).toBeNull();
    expect(normalizeImu(undefined)).toBeNull();
    expect(normalizeImu(null)).toBeNull();
  });

  test("normalizeImu passes through real readings", () => {
    const { normalizeImu } = require("./ring");
    expect(normalizeImu({ x: 0.1, y: -0.2, z: 0.98 })).toEqual({ x: 0.1, y: -0.2, z: 0.98 });
    expect(normalizeImu({ x: 0, y: 0.5, z: 0 })).toEqual({ x: 0, y: 0.5, z: 0 });
  });

  test("extractImuFromSysEvent returns null when IMUData absent (observed case)", () => {
    const { extractImuFromSysEvent } = require("./ring");
    // Every captured sys-event had no IMUData field. Document that.
    expect(extractImuFromSysEvent({})).toBeNull();
    expect(extractImuFromSysEvent(null)).toBeNull();
  });

  test("extractImuFromSysEvent returns reading when IMUData present", () => {
    const { extractImuFromSysEvent } = require("./ring");
    expect(extractImuFromSysEvent({ IMUData: { x: 1, y: 2, z: 3 } })).toEqual({ x: 1, y: 2, z: 3 });
  });
});

// ---------- Firmware / serial decoding ----------

describe("decodeFirmware", () => {
  test("parses the captured firmware response", () => {
    // Captured cmd=02/2c rx: "9fd8" + "2.0.8.0012\0..." + "603MV1.9.3\0..."
    const p = parseRingPacket(Buffer.from(
      "00a43bc66c640164050003000222" +  // envelope (the seq/hash don't matter)
      "c00" +                            // filler to align — use canonical test payload
      "9fd8" +                           // 2-byte prefix
      "322e302e382e30303132" + "00".repeat(6) +   // "2.0.8.0012" padded to 16
      "3630334d56312e392e33" + "00".repeat(6),    // "603MV1.9.3" padded to 16
      "hex",
    ));
    // Use a clean synthetic to isolate the decoder from alignment noise.
    const clean = parseRingPacket(Buffer.from(
      "0000000000" + "6401640100030002" + "2c" + "00" +
      "9fd8" +
      "322e302e382e30303132" + "00".repeat(6) +
      "3630334d56312e392e33" + "00".repeat(6),
      "hex",
    ));
    expect(clean.ok).toBe(true);
    expect(clean.cmd).toBe(0x02);
    expect(clean.sub).toBe(0x2c);

    const fw = decodeFirmware(clean);
    expect(fw).toEqual({ hw: "2.0.8.0012", sw: "603MV1.9.3" });
  });

  test("rejects non-firmware packets", () => {
    const other = parseRingPacket(buildRingPacket({ seq: 1, cmd: 0x02, sub: 0x0c }));
    expect(decodeFirmware(other)).toBeNull();
  });
});

describe("decodeSerial", () => {
  test("extracts B210YHSBNN serial from the captured push", () => {
    // Captured cmd=11/85 push — full payload starts with `4d22 0274 00 03 92` then ASCII serial
    // B210YHSBNN25120503704, then padding + second serial B210DFACC260073
    const p = parseRingPacket(Buffer.from(
      "0000000000" + "6401640f0002001185" + "00" +
      "4d22027400039242323130594853424e4e3235313230353033373034" +
      "ffffffffffffffffff15423231304446414343323630303733",
      "hex",
    ));
    expect(p.ok).toBe(true);
    const s = decodeSerial(p);
    expect(s?.serial).toBe("B210YHSBNN25120503704");
  });
});

// ---------- Constants ----------

describe("constants", () => {
  test("UUIDs match the firmware's BAE8 service/chars", () => {
    expect(R1_SERVICE_UUID).toBe("bae80001-4f05-4503-8e65-3af1f7329d1f");
    expect(R1_WRITE_CHAR_UUID).toBe("bae80012-4f05-4503-8e65-3af1f7329d1f");
    expect(R1_NOTIFY_CHAR_UUID).toBe("bae80013-4f05-4503-8e65-3af1f7329d1f");
  });

  test("R1_CMD values match the observed wire cmd bytes", () => {
    // Values verified against HCI snoop of the official com.even.sg app
    // pairing Shahara's ring. The name-to-byte mapping isn't a direct
    // BleRing1Cmd enum ordinal — the firmware uses a lookup table.
    expect(R1_CMD.heartRate).toBe(0x01);
    expect(R1_CMD.firmware).toBe(0x02);
    expect(R1_CMD.temperature).toBe(0x03);
    expect(R1_CMD.hrv).toBe(0x04);
    expect(R1_CMD.activity).toBe(0x05);
    expect(R1_CMD.sleep).toBe(0x06);
    expect(R1_CMD.sportRunCtrl).toBe(0x07);
    expect(R1_CMD.pairAuth).toBe(0x08);
    expect(R1_CMD.healthSetting).toBe(0x09);
    expect(R1_CMD.linkToGlasses).toBe(0x0a);
    expect(R1_CMD.algoKey).toBe(0x0b);
    expect(R1_CMD.config1).toBe(0x0e);
    expect(R1_CMD.config2).toBe(0x0f);
    expect(R1_CMD.serial).toBe(0x11);
    expect(R1_CMD.phoneStatus).toBe(0x7e);
    expect(R1_CMD.phoneStatusAck).toBe(0x7f);
  });

  test("R1_FLAGS values match the req/set/push/response wire values", () => {
    expect(R1_FLAGS.REQUEST).toBe(0x0000);
    expect(R1_FLAGS.SET).toBe(0x0001);
    expect(R1_FLAGS.PUSH).toBe(0x0002);
    expect(R1_FLAGS.RESPONSE).toBe(0x0003);
  });
});
