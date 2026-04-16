// BLE connection + notification plumbing for the G2 glasses.
//
// Both temples are separate peripherals advertising under names matching
// `Even G#_<serial>_<L|R>_...`. Each arm exposes two notify characteristics
// we care about:
//
//   5402 "content_notify" — envelope-framed protobuf traffic. The glasses'
//     async command channels (sid=0xe0 flag=0x01 etc.) only fire on the
//     RIGHT arm; the left arm is receive-for-writes only on this channel.
//
//   6402 "render_notify" — unframed payload stream. In particular, after
//     AudioCtrCmd enables audio, the raw LC3 packets arrive on the LEFT
//     arm's 6402. See ~/bletools/lib/audio.ts.

import noble from "@stoprocent/noble";
import type { Peripheral, Characteristic } from "@stoprocent/noble";

import { parseFrame } from "./envelope";
import type { ParsedFrame } from "./envelope";

export const NAME_RE = /(?:even\s+)?G\d+_(\d+)_([LR])_/i;

// Service 5450 - content (main G2 protocol, commands/responses)
export const WRITE_CHAR_UUID = "00002760-08c2-11e1-9073-0e8ac72e5401";
export const NOTIFY_CHAR_UUID = "00002760-08c2-11e1-9073-0e8ac72e5402";

// Service 6450 - render (streaming data including audio)
export const RENDER_WRITE_UUID = "00002760-08c2-11e1-9073-0e8ac72e6401";
export const RENDER_NOTIFY_UUID = "00002760-08c2-11e1-9073-0e8ac72e6402";

function fullUuid(u: string): string {
  const s = u.toLowerCase().replace(/-/g, "");
  return s.length === 32
    ? `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
    : s;
}

export function ts(): string {
  const t = new Date();
  return `${t.toISOString().slice(11, 19)}.${String(t.getMilliseconds()).padStart(3, "0")}`;
}

export interface ArmHandles {
  label: string;
  side: "L" | "R";
  peripheral: Peripheral;
  write: Characteristic;
  notify: Characteristic;
  renderNotify: Characteristic | null;
  waiters: Map<string, (f: ParsedFrame) => void>;
  listeners: Set<(f: ParsedFrame, raw: Uint8Array) => void>;
  renderListeners: Set<(data: Uint8Array) => void>;
  /** Serializes multi-fragment writes so heartbeats can't interleave with REBUILDs. */
  writeLock: Promise<void>;
}

export interface BothArms {
  L: Peripheral;
  R: Peripheral;
}

export async function findBothArms(timeoutMs = 90_000): Promise<BothArms> {
  if (noble.state !== "poweredOn") await noble.waitForPoweredOnAsync(6000);
  return new Promise(async (resolve, reject) => {
    const seen = new Map<"L" | "R", Peripheral>();
    const onDiscover = (p: Peripheral) => {
      const m = NAME_RE.exec(p.advertisement.localName || "");
      if (!m) return;
      const side = m[2]!.toUpperCase() as "L" | "R";
      if (!seen.has(side)) {
        console.log(`[${ts()}] saw ${side}`);
        seen.set(side, p);
      }
      if (seen.has("L") && seen.has("R")) {
        noble.off("discover", onDiscover);
        noble.stopScanningAsync().then(() => resolve({ L: seen.get("L")!, R: seen.get("R")! }));
      }
    };
    noble.on("discover", onDiscover);
    await noble.startScanningAsync([], true);
    setTimeout(() => {
      noble.off("discover", onDiscover);
      noble.stopScanningAsync().then(() => {
        if (seen.size < 2) reject(new Error("g2-find timeout"));
        else resolve({ L: seen.get("L")!, R: seen.get("R")! });
      });
    }, timeoutMs);
  });
}

export async function connectArm(
  p: Peripheral,
  label: string,
  side: "L" | "R",
): Promise<ArmHandles> {
  await p.connectAsync();
  const { characteristics } = await p.discoverAllServicesAndCharacteristicsAsync();
  const write = characteristics.find((c) => fullUuid(c.uuid) === WRITE_CHAR_UUID);
  const notify = characteristics.find((c) => fullUuid(c.uuid) === NOTIFY_CHAR_UUID);
  const renderNotify = characteristics.find((c) => fullUuid(c.uuid) === RENDER_NOTIFY_UUID) ?? null;
  if (!write || !notify) throw new Error(`${label}: write/notify char missing`);

  const arm: ArmHandles = {
    label, side, peripheral: p, write, notify, renderNotify,
    waiters: new Map(),
    listeners: new Set(),
    renderListeners: new Set(),
    writeLock: Promise.resolve(),
  };

  notify.on("data", (data: Buffer) => {
    const raw = new Uint8Array(data);
    const parsed = parseFrame(raw);
    if (parsed.ok && parsed.msgSeq !== undefined) {
      const key = `${parsed.sid}:${parsed.msgSeq}`;
      const w = arm.waiters.get(key);
      if (w) { arm.waiters.delete(key); w(parsed); }
    }
    for (const fn of arm.listeners) {
      try { fn(parsed, raw); } catch (e) { console.error(`${label} listener`, e); }
    }
  });
  await notify.subscribeAsync();

  // Render channel (6402) carries raw, unframed payloads (e.g. LC3 audio
  // from the L arm after AudioCtrCmd). It must not go through parseFrame.
  if (renderNotify) {
    renderNotify.on("data", (data: Buffer) => {
      const raw = new Uint8Array(data);
      for (const fn of arm.renderListeners) {
        try { fn(raw); } catch (e) { console.error(`${label} render listener`, e); }
      }
    });
    await renderNotify.subscribeAsync();
  }

  // Noble installs a once-listener per write on the peripheral's inner
  // emitter; after ~11 concurrent writes, it hits MaxListeners=10 and
  // warns. Bump the cap.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inner = (p as any)._noble;
  if (inner && typeof inner.setMaxListeners === "function") inner.setMaxListeners(2000);

  return arm;
}

export function waitForAck(
  arm: ArmHandles,
  sid: number,
  seq: number,
  timeoutMs: number,
): Promise<ParsedFrame | null> {
  return new Promise((resolve) => {
    const key = `${sid}:${seq}`;
    const t = setTimeout(() => { arm.waiters.delete(key); resolve(null); }, timeoutMs);
    arm.waiters.set(key, (f) => { clearTimeout(t); resolve(f); });
  });
}

export type WriteLockHolder = { writeLock: Promise<void> };

export async function withWriteLock<T>(holder: WriteLockHolder, fn: () => Promise<T>): Promise<T> {
  const prev = holder.writeLock;
  let release!: () => void;
  holder.writeLock = new Promise<void>((r) => { release = r; });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function sendFrames(arm: ArmHandles, frames: Uint8Array[]): Promise<void> {
  await withWriteLock(arm, async () => {
    for (const f of frames) await arm.write.writeAsync(Buffer.from(f), true);
  });
}

export function onFrame(
  arm: ArmHandles,
  fn: (f: ParsedFrame, raw: Uint8Array) => void,
): () => void {
  arm.listeners.add(fn);
  return () => { arm.listeners.delete(fn); };
}

export function onRender(
  arm: ArmHandles,
  fn: (data: Uint8Array) => void,
): () => void {
  arm.renderListeners.add(fn);
  return () => { arm.renderListeners.delete(fn); };
}
