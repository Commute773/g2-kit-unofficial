#!/usr/bin/env bun
// Push a generated image to the lens using the full image pipeline.
//
// Demonstrates:
//   - Building a 4bpp EvenHub BMP from a procedural pixel function
//   - Using G2ImageStreamer (the right way to push images — handles the
//     first-stream-dropped firmware bug, sliding-window Cmd=3, ack-miss
//     tolerance, etc)
//
//     bun examples/image.ts
//
// Watch the lens: a diagonal gradient appears, then a circle, then the
// session closes.

import { G2Session, buildEvenHubBmp, G2_LENS_WIDTH, G2_LENS_HEIGHT } from "g2-kit/ble";
import { G2ImageStreamer, type ImageContainerSpec, startHeartbeat } from "g2-kit/ui";

let magic = 100;
const nextMagic = () => (magic = magic >= 255 ? 100 : magic + 1);

const session = await G2Session.open();
const hb = startHeartbeat({ session, nextMagic });

const streamer = new G2ImageStreamer({ session, nextMagic });

// One-container, full-lens layout. For richer frames (multi-tile, 2×2
// grid) see the rgbaToEvenHubTiles helper in g2-kit/ble/image.ts — it
// handles the tiling math automatically.
const containers: ImageContainerSpec[] = [{
  name: "demo-img",
  containerId: 10,
  x: 0,
  y: 0,
  width: G2_LENS_WIDTH,
  height: G2_LENS_HEIGHT,
}];

async function push(pixel: (x: number, y: number) => number, fp: string) {
  const bmp = buildEvenHubBmp(G2_LENS_WIDTH, G2_LENS_HEIGHT, pixel);
  const result = await streamer.render(containers, [{ bmp }], fp);
  console.log(`frame "${fp}" → ${result}`);
}

// Frame 1: diagonal gradient.
await push((x, y) => Math.min(15, (x + y) >> 5), "gradient");
await new Promise((r) => setTimeout(r, 1500));

// Frame 2: circle.
const cx = G2_LENS_WIDTH / 2;
const cy = G2_LENS_HEIGHT / 2;
const maxR = Math.min(cx, cy);
await push(
  (x, y) => {
    const r = Math.hypot(x - cx, y - cy);
    return r < maxR * 0.8 ? 15 : 0;
  },
  "circle",
);
await new Promise((r) => setTimeout(r, 1500));

// Frame 3: dedup test — same fingerprint, should be a no-op render.
await push(
  (x, y) => {
    const r = Math.hypot(x - cx, y - cy);
    return r < maxR * 0.8 ? 15 : 0;
  },
  "circle", // SAME fingerprint: streamer returns "deduped"
);

hb.stop();
await session.close();
process.exit(0);
