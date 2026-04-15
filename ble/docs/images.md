# Images — format, tiling, streaming pipeline

The G2 lens renders images as a grid of **tiles** inside an ImageContainer.
Each tile is a 4 bpp indexed bitmap with a fixed palette, streamed to the
firmware via Cmd=3 UpdateImageRawData fragments.

## Pixel format

- **4 bits per pixel.** Two pixels packed per byte, high nibble first.
- **16-entry palette, fixed.** The firmware ignores any palette you send;
  index `0` is transparent, `1..15` are monochrome shades from dim to bright.
  On the lens green it mostly just picks one or two shades — treat the
  palette as "0 = off, 15 = on" and any threshold in between as subtle.
- **Row-major, top-down.** No padding between rows; no stride.
- `width` and `height` in `ImageObject` must match the raw data you push,
  byte-for-byte: `bytes = ceil(w * h / 2)`.

To render a 1-bit bitmap, convert to 4 bpp by mapping `1 → 15`, `0 → 0`. The
lens will not see the difference.

## Tiling — 288×144 tiles, 2×2 grid

The full lens is **576×288** pixels. The practical maximum tile size before
the firmware chokes on a single Cmd=3 burst is **288×144** — half the lens in
each dimension. A full-lens image is therefore a 2×2 grid of these tiles.

```
┌────────────┬────────────┐
│   (0,0)    │   (1,0)    │
│  288×144   │  288×144   │
├────────────┼────────────┤
│   (0,1)    │   (1,1)    │
│  288×144   │  288×144   │
└────────────┴────────────┘
```

Smaller images can use a single tile or a smaller grid. The `image.ts` helper
picks the smallest grid that covers the rendered region.

Each tile has:
- A stable **`id`** (we use `"t{col}-{row}"`).
- Its own Cmd=3 fragment stream.
- Its own `bounds` rect inside the ImageContainer.

The `ImageStreamer` class in `g2-kit/ui` owns the whole pipeline and is the
right place to start if you just want to push images to the lens.

## Streaming pipeline (Cmd=3)

For each tile, the host must push the tile's pixel bytes in order:

```
Cmd=3 UpdateImageRawData {
  container_name: "img-a",
  object_id:      "t0-0",
  offset:         0,      // bytes from start of tile buffer
  data:           <≤4 KB raw bytes>,
  is_last:        false,
}
...
Cmd=3 UpdateImageRawData {
  ...
  offset:         N,
  data:           <last chunk>,
  is_last:        true,   // render after this one
}
```

- **4 KB soft cap per fragment.** The firmware silently drops any fragment
  whose `data` exceeds this. Use ~3800 B to stay safely below with envelope
  overhead.
- **Must push in offset order.** Out-of-order fragments confuse the
  reassembly buffer.
- **`is_last=true` triggers the render.** Until you send an `is_last`
  fragment, the firmware holds the tile's current content on screen.

## The sliding-window pipeline

Waiting for each Cmd=3 ack before sending the next fragment gives you
terrible throughput — the BLE write/ack round-trip dominates. Instead, we run
a **sliding window** of in-flight fragments:

- Default window size **4** (configurable in `ImageStreamer`).
- Keep N Cmd=3 writes in flight at once.
- Match acks by `magic` and retire fragments as they ack.
- If an ack is late (>~500 ms), assume it was dropped and slide on anyway —
  see "ack-miss tolerance" below.

With a window of 4 on a full-lens 288×288 image (8 tiles × ~3.8 KB each) we
reach roughly the numbers in the throughput table below.

## First-stream-dropped bug + warmup

**The very first Cmd=3 burst of a freshly-created ImageContainer silently
drops its rendered output.** The fragments are accepted, the `is_last` fires,
the ack comes back — and nothing is on the lens. This is a firmware bug, not
a protocol error, and it only affects the first stream.

Workaround: after creating the container, push a **sacrificial warmup frame**
with known contents (all-zero, or a flat splash) before your real content.
The warmup is discarded; the next frame renders correctly. The ImageStreamer
handles this with a `warmedUp` flag — the first real frame is actually the
second frame we push.

## Ack-miss tolerance

Occasionally the firmware does not ack a Cmd=3 write even though it was
accepted and rendered. If you treat an ack miss as a hard error, you'll
abort a frame that actually rendered and the user sees a stutter.

The streamer tracks **consecutive ack misses** per stream:

- Up to ~3 missing acks: keep sliding forward, assume the fragments
  landed. Acks for later offsets will catch up.
- More than 3 consecutive misses: something is actually wrong — fall back to
  a REBUILD or reset.

This loses zero frames in practice and is invisible to the caller.

## Geometry-key fast path

Most frame-to-frame updates keep the exact same tile layout (same number of
tiles, same sizes, same ids). For these, we skip Cmd=7 UpdateContainer
entirely and go straight to Cmd=3 streaming. We key on a small
**geometry key** computed from the tile layout and only issue a REBUILD when
the key changes.

This matters because Cmd=7 REBUILD is expensive enough to drop a frame's
worth of latency.

## Fingerprint dedup

If the caller re-renders the same exact pixel contents (very common — React
triggers a lot of no-op re-renders), we hash the tile contents once and
compare against the last fingerprint. If equal, the streamer does nothing and
returns immediately. Cheapest render there is.

## Throughput ceiling

Observed on-lens throughput with the library's streamer, window size 4:

| Tiles | Size per tile | Aggregate | Notes |
|---|---|---|---|
| 1 | 48×48 (~1.2 KB) | **~20 fps** | Small HUD updates. |
| 4 | 144×144 (~10 KB) | ~12 fps | Quarter-lens rich content. |
| 8 | 288×144 (~20 KB) | ~5 fps (**~8.8 KB/s**) | Full lens, worst case. |

The 8.8 KB/s figure is the effective BLE ceiling on this firmware after
envelope + ack overhead is accounted for. There is no way to go faster
without firmware changes.

## Stuck-session trap

If the plugin task gets into a bad state (watchdog partial tear-down,
orphaned MapSessionId, previous session aborted mid-stream), **re-creating
the container with an adjacent MapSessionId inherits the failed state** —
the "new" session gets the old one's broken buffers.

Workaround: after any abort, bump the MapSessionId by a larger step before
the next CREATE. The ImageStreamer does this via `sessionCounter` += 2 on
reset.

Symptom: a fresh-looking CREATE succeeds, but the first Cmd=3 burst never
acks and never renders. If you see this twice in a row on the same name,
you're in the stuck-session trap.
