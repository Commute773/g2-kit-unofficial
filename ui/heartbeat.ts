// G2 plugin heartbeat.
//
// The firmware's dead-plugin watchdog tears down the plugin task if it hasn't
// seen traffic for ~10s. Mirai beats every ~5s; that's a good default.
//
// A heartbeat before the first CREATE is wasted (the plugin task doesn't
// exist yet), so `shouldBeat` lets the caller gate on "has the first
// container been created?"

import type { G2SessionLike } from "../ble";
import { buildHeartbeat, ts } from "../ble";

export type HeartbeatOpts = {
  session: G2SessionLike;
  nextMagic: () => number;
  /** Gate — return false to skip this beat. Defaults to always-beat. */
  shouldBeat?: () => boolean;
  /** Beat interval in ms. Default 5000. */
  intervalMs?: number;
  /** Ack wait-time in ms. Default 1500. */
  ackTimeoutMs?: number;
  log?: (msg: string) => void;
  /**
   * Called after each attempted beat with the outcome. `ok=true` means
   * the firmware acked within `ackTimeoutMs`; `ok=false` means the
   * ack timed out or `sendPb` threw. Skipped beats (from
   * `shouldBeat`) don't fire this callback.
   */
  onBeat?: (ok: boolean, err?: unknown) => void;
};

export type HeartbeatHandle = {
  stop(): void;
};

/**
 * Start a heartbeat loop. Returns a handle with `stop()`. Calling `start()`
 * twice before stopping is a no-op (the second call returns a handle that
 * stops the first loop).
 */
export function startHeartbeat(opts: HeartbeatOpts): HeartbeatHandle {
  const {
    session,
    nextMagic,
    shouldBeat = () => true,
    intervalMs = 5000,
    ackTimeoutMs = 1500,
    log = (m) => console.error(m),
    onBeat,
  } = opts;

  const timer = setInterval(async () => {
    if (!shouldBeat()) return;
    try {
      const hb = buildHeartbeat({ magic: nextMagic() });
      const ack = await session.sendPb(0xe0, hb.pb, hb.magic, { ackTimeoutMs });
      onBeat?.(ack !== null);
    } catch (e) {
      log(`[${ts()}] heartbeat error ${(e as Error)?.message ?? e}`);
      onBeat?.(false, e);
    }
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
