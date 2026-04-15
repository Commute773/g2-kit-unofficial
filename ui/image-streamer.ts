// G2 image streaming pipeline.
//
// The firmware has several quirks that any image consumer has to work around,
// so rather than forcing every app to re-discover them, this class encapsulates:
//
//  1. Content-sensitive fingerprint dedup — back-to-back identical frames
//     skip the whole BLE round-trip.
//  2. Multi-container REBUILD — all image containers must be declared in a
//     single Cmd=7 frame; per-tile REBUILDs silently overwrite each other.
//  3. Container-geometry key — if only pixels change (bad-apple style
//     playback), skip the REBUILD entirely and stream straight to the
//     existing containers. Saves ~100ms per frame.
//  4. First-stream warmup — the very first Cmd=3 pixel stream in a session
//     is silently dropped, so we prepend a sacrificial warmup on container 0
//     using tile 0's bytes.
//  5. Sliding-window Cmd=3 pipeline — up to `windowSize` acks in flight at
//     any time so animation frames never drain to zero between renders.
//  6. Ack-miss tolerance — the firmware occasionally swallows an ack under
//     load but the pixel data still lands. Dropping session state on a
//     single miss cascades into SYSTEM_EXIT; instead we count misses and
//     keep streaming.
//
// Reset the streamer (via `reset()`) when the firmware tears down the plugin
// task (SYSTEM_EXIT / ABNORMAL_EXIT / FOREGROUND_EXIT).

import type {
  G2SessionLike,
  ParsedFrame,
} from "../ble";
import {
  buildImageContainers,
  buildImageRawData,
  planImageFragments,
  ts,
} from "../ble";

export type ImageContainerSpec = {
  name: string;
  containerId: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ImageTileData = {
  /** Raw EvenHub BMP bytes for this tile. */
  bmp: Uint8Array;
};

export type ImageStreamerOpts = {
  session: G2SessionLike;
  nextMagic: () => number;
  /** How many Cmd=3 acks we allow in flight at once. Default 4. */
  windowSize?: number;
  /**
   * Called when a REBUILD successfully declares new image containers. The
   * consumer should invalidate any cached list/text container state because
   * the firmware tears them down as a side-effect of a new image page.
   */
  onRebuildSuccess?: () => void;
  /** Logger for pipeline events. Defaults to console.log. */
  log?: (msg: string) => void;
};

export type ImageStreamResult =
  | "rendered"
  | "deduped"
  | "rebuild-failed"
  | "warmup-failed";

export class G2ImageStreamer {
  private readonly session: G2SessionLike;
  private readonly nextMagic: () => number;
  private readonly windowSize: number;
  private readonly onRebuildSuccess: () => void;
  private readonly log: (msg: string) => void;

  private lastFingerprint = "";
  private created = false;
  private warmedUp = false;
  private lastContainerKey = "";
  private sessionCounter = 0;
  private readonly inFlight: Promise<ParsedFrame | null>[] = [];
  private ackMisses = 0;

  constructor(opts: ImageStreamerOpts) {
    this.session = opts.session;
    this.nextMagic = opts.nextMagic;
    this.windowSize = opts.windowSize ?? 4;
    this.onRebuildSuccess = opts.onRebuildSuccess ?? (() => {});
    this.log = opts.log ?? ((m) => console.log(m));
  }

  /**
   * Fingerprint shorthand — callers typically compute this from screen
   * metadata before calling `render` so they can correlate with their own
   * dedup scheme. The streamer keeps its own internal fingerprint too.
   */
  computeFingerprint(tiles: { x: number; y: number; width: number; height: number; bmpBase64?: string }[]): string {
    // Must be content-sensitive: bad-apple frames are all the same size, so a
    // length-only hash would dedupe every frame as identical. We slice a
    // chunk of the base64 payload — cheap and good enough without a real hash.
    return (
      "image\0" +
      tiles
        .map(
          (t) =>
            `${t.x},${t.y}:${t.width}x${t.height}:${t.bmpBase64?.length ?? 0}:${t.bmpBase64?.slice(200, 264) ?? ""}`,
        )
        .join("|")
    );
  }

  /**
   * Render a frame. Containers and tiles are 1:1 — tile[i] streams into
   * container[i]. The caller is responsible for decoding base64 bytes into
   * Uint8Array; `fingerprint` is any stable string used to dedup identical
   * back-to-back pushes.
   */
  async render(
    containers: ImageContainerSpec[],
    tiles: ImageTileData[],
    fingerprint: string,
  ): Promise<ImageStreamResult> {
    if (fingerprint === this.lastFingerprint && this.created) {
      this.log(`[${ts()}] render-dedup image (fp unchanged)`);
      return "deduped";
    }
    if (containers.length !== tiles.length) {
      throw new Error(
        `G2ImageStreamer.render: containers (${containers.length}) and tiles (${tiles.length}) length mismatch`,
      );
    }

    // One multi-ImageObject REBUILD declares all N containers in a single
    // frame. Per-tile REBUILDs don't work: each REBUILD fully replaces the
    // image page layout (only the most recent container survives), so all
    // containers must be declared together. When the container geometry is
    // identical to the last render (bad-apple frame loop), we skip the
    // REBUILD entirely and go straight to streaming, saving ~100 ms per frame.
    const containerKey = containers
      .map(
        (c) =>
          `${c.name}:${c.containerId}:${c.x},${c.y}:${c.width}x${c.height}`,
      )
      .join("|");
    if (containerKey !== this.lastContainerKey || !this.created) {
      const rebuild = buildImageContainers({
        containers,
        magic: this.nextMagic(),
      });
      const tRebuild = performance.now();
      const rebuildAck = await this.session.sendPb(
        0xe0,
        rebuild.pb,
        rebuild.magic,
      );
      const dtRebuild = performance.now() - tRebuild;
      this.log(
        `[${ts()}] image-rebuild ${containers.length} containers ${dtRebuild.toFixed(0)}ms${rebuildAck ? "" : " [no ack]"}`,
      );
      if (!rebuildAck) {
        this.created = false;
        this.lastContainerKey = "";
        this.lastFingerprint = "";
        return "rebuild-failed";
      }
      this.created = true;
      this.lastContainerKey = containerKey;
      this.onRebuildSuccess();
    }

    // First-stream dropped bug: on a fresh image page, the firmware silently
    // drops the first Cmd=3 pixel-data stream it receives. Diagnosed by
    // swapping stream order — whichever tile we stream first is the one that
    // never appears. It's purely ordinal. So on the first image render of a
    // session we prepend a sacrificial warmup stream (re-using tile 0's
    // bytes on container 0) to absorb the loss.
    if (!this.warmedUp) {
      const warmupOk = await this.streamWarmup(containers[0]!, tiles[0]!.bmp);
      if (!warmupOk) return "warmup-failed";
    }

    // Stream each tile's pixel data as Cmd=3 fragments into the persistent
    // sliding-window pipeline. Missed acks are warnings, not fatals — the
    // firmware sometimes swallows one under sustained load but the pixel
    // data still lands, and cascading a REBUILD on a single miss just
    // stresses the firmware further until SYSTEM_EXIT.
    for (let i = 0; i < containers.length; i++) {
      await this.streamTile(containers[i]!, tiles[i]!.bmp);
    }

    this.warmedUp = true;
    this.lastFingerprint = fingerprint;
    return "rendered";
  }

  private async streamWarmup(
    c: ImageContainerSpec,
    bmp: Uint8Array,
  ): Promise<boolean> {
    const warmupId = this.sessionCounter;
    this.sessionCounter = (this.sessionCounter + 1) & 0xff;
    const frags = planImageFragments(bmp);
    const tWarmup = performance.now();
    let warmupSent = 0;
    for (const frag of frags) {
      const raw = buildImageRawData({
        containerId: c.containerId,
        containerName: c.name,
        mapSessionId: warmupId,
        mapTotalSize: bmp.length,
        mapFragmentIndex: frag.index,
        mapRawData: frag.data,
        magic: this.nextMagic(),
      });
      const ack = await this.session.sendPb(0xe0, raw.pb, raw.magic, {
        ackTimeoutMs: 10_000,
      });
      if (!ack) {
        this.log(
          `[${ts()}] image-warmup #${frag.index} [no ack] aborting`,
        );
        this.created = false;
        this.lastFingerprint = "";
        return false;
      }
      warmupSent++;
    }
    this.log(
      `[${ts()}] image-warmup ${c.name} ${warmupSent}/${frags.length} frags ${(performance.now() - tWarmup).toFixed(0)}ms`,
    );
    return true;
  }

  private async streamTile(
    c: ImageContainerSpec,
    bmp: Uint8Array,
  ): Promise<void> {
    const mapSessionId = this.sessionCounter;
    this.sessionCounter = (this.sessionCounter + 1) & 0xff;
    const fragments = planImageFragments(bmp);
    const tTile = performance.now();
    for (const frag of fragments) {
      while (this.inFlight.length >= this.windowSize) {
        await this.drainOne();
      }
      const raw = buildImageRawData({
        containerId: c.containerId,
        containerName: c.name,
        mapSessionId,
        mapTotalSize: bmp.length,
        mapFragmentIndex: frag.index,
        mapRawData: frag.data,
        magic: this.nextMagic(),
      });
      // Short ack timeout — if the firmware is going to answer, it does so
      // fast. A long timeout just stalls the window and piles more pressure
      // on the already-slow firmware.
      const { ack } = await this.session.sendPbPipelined(
        0xe0,
        raw.pb,
        raw.magic,
        { ackTimeoutMs: 1_000 },
      );
      this.inFlight.push(ack);
    }
    const dtTile = performance.now() - tTile;
    this.log(
      `[${ts()}] image-tile ${c.name} ${bmp.length}B ${fragments.length} frags ${dtTile.toFixed(0)}ms (w=${this.windowSize} inflight=${this.inFlight.length} miss=${this.ackMisses})`,
    );
  }

  private async drainOne(): Promise<void> {
    const p = this.inFlight.shift();
    if (!p) return;
    const a = await p;
    if (a === null) {
      this.ackMisses++;
      this.log(
        `[${ts()}] image-ack miss (total=${this.ackMisses}) — continuing`,
      );
    }
  }

  /**
   * Drop all image-streamer state. Call on firmware plugin-task teardown
   * (SYSTEM_EXIT / ABNORMAL_EXIT / FOREGROUND_EXIT).
   */
  reset(): void {
    this.created = false;
    this.warmedUp = false;
    this.lastContainerKey = "";
    this.lastFingerprint = "";
    this.inFlight.length = 0;
    this.ackMisses = 0;
  }
}
