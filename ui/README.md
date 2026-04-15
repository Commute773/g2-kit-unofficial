# g2-kit/ui

Layer 2: app-level abstractions built on top of [`g2-kit/ble`](../ble).

Pure, side-effect-free helpers. Everything here exists because writing a real G2 integration taught us the same lesson four times: the raw protocol is not the whole story. The firmware has a first-stream-dropped bug. It can't handle concurrent writes. The heartbeat has to be gated on first-CREATE. List scrolling doesn't work without injected nav rows. Etc.

This package collects the workarounds and the non-obvious glue so you don't have to discover them again.

## Modules

| File | Exports | What it does |
|---|---|---|
| `pager.ts` | `buildPagerView`, `createPagerState`, `pagerScroll`, `pagerResolveTap`, `PagerState`, `PagerView`, `LIST_PAGE_SIZE`, `NAV_PREV_LABEL`, `NAV_NEXT_LABEL` | List pagination with injected `▲ Prev` / `▼ Next` rows. Pure functions — no BLE, no I/O. |
| `image-streamer.ts` | `G2ImageStreamer`, `ImageContainerSpec` | The whole image pipeline: fingerprint dedup, multi-container REBUILD, first-stream warmup, sliding-window Cmd=3, ack-miss tolerance. |
| `heartbeat.ts` | `startHeartbeat`, `HeartbeatOpts`, `HeartbeatHandle` | Gated 5s heartbeat loop. Stops the plugin task from timing out. |
| `render-coalescer.ts` | `RenderCoalescer` | One-deep async queue. Serializes renders and drops intermediate frames so the latest state wins. |

## Pager

**Why pagination instead of scrolling:** the G2's two lens displays aren't perfectly synchronized. During animated scrolls one arm ticks a frame before the other, and that desync window is physically uncomfortable — for some users it's a headache trigger. Paging with instant frame swaps avoids the animation entirely, so you never spend time inside the desync window.

(Technical side benefit: the firmware owns cursor and scrolling on-device, but `SCROLL_TOP` / `SCROLL_BOTTOM` events only fire on taps, not on user-driven scrolling — so even if the lenses were synced, you couldn't react to scroll reliably anyway.)

To get real pagination you inject `▲ Prev page` and `▼ Next page` rows into the list yourself and map taps on those rows to offset mutations. `pager.ts` does the index math.

`pager.ts` does the index math:

```ts
import { buildPagerView, pagerResolveTap, createPagerState } from "g2-kit/ui";

const state = createPagerState(allItems);
const view = buildPagerView(allItems, state.offset);

// view.rendered is what you push to the list container — content + nav rows.
// view.upIdx / view.downIdx are the viewport indices of the nav rows (or -1).

// On a tap, resolve it:
const action = pagerResolveTap(state, tappedViewportIndex);
// action === { kind: "prev" } | { kind: "next" } | { kind: "item", index: 12 }
```

All pure — no BLE, no protobuf, no side effects. You bring your own list container plumbing; this just tells you what to render and how taps map back.

## Image streamer

`G2ImageStreamer` is the only way you should be pushing images to the lens. The raw `buildUpdateImageContainer` + `Cmd=3 UpdateImageRawData` primitives are exported from `g2-kit/ble` for completeness, but using them directly means re-implementing:

- **Fingerprint dedup** — React re-renders are frequent and usually no-ops. We hash the tiles and skip if unchanged.
- **Multi-container REBUILD** — Cmd=7 UpdateContainer with multiple `ImageObject`s in a single frame atomically tears down old tiles. Sibling containers in the plugin task can get torn down as collateral; the `onRebuildSuccess` callback lets you invalidate their state.
- **Geometry-key fast path** — most frame-to-frame updates keep the same tile layout. We skip the Cmd=7 REBUILD entirely and go straight to Cmd=3 streaming when the layout key is unchanged.
- **First-stream warmup** — the firmware silently drops the *first* Cmd=3 burst after a CREATE. We push a sacrificial warmup and treat the second frame as your real first frame.
- **Sliding-window Cmd=3 pipeline** — window size 4 by default. Without this you get maybe 1–2 fps on a full-lens image.
- **Ack-miss tolerance** — occasional Cmd=3 acks just don't come back even though the fragment landed. Treating that as fatal drops frames that actually rendered. We tolerate up to ~3 consecutive misses.
- **Stuck-session trap** — after an abort, bump the internal session counter so the firmware doesn't re-use the failed buffers.

```ts
import { G2ImageStreamer } from "g2-kit/ui";

const streamer = new G2ImageStreamer({
  session,
  nextMagic,
  onRebuildSuccess: () => {
    // After a REBUILD the firmware may have torn down sibling list/text
    // containers. Flag them for recreate on the next render.
    listCreated = false;
    textCreated = false;
  },
});

const fingerprint = streamer.computeFingerprint(tiles);
const result = await streamer.render(containers, tileData, fingerprint);
// result === "rendered" | "deduped" | "failed"
```

See `docs/images.md` in the ble package for the full protocol details.

## Heartbeat

The G2 plugin task's dead-man watchdog tears everything down after ~10s without traffic. Mirai (the vendor app) beats every ~5s; we default to the same.

```ts
import { startHeartbeat } from "g2-kit/ui";

const handle = startHeartbeat({
  session,
  nextMagic,
  // A heartbeat BEFORE the first CREATE is wasted (the plugin task doesn't
  // exist yet). Gate on your own first-create flag:
  shouldBeat: () => firstCreateDone,
});

// ...later:
handle.stop();
```

`shouldBeat` defaults to always-beat. Override it if you're doing a lifecycle where the plugin task comes and goes.

## Render coalescer

The G2 firmware can't handle concurrent Cmd=7 writes on the same channel — two in-flight renders jam the BLE write queue and leave both hanging. You have to serialize.

But just serializing isn't enough: if backend events are flying in faster than the firmware can render (a user scrolling fast), you'd queue up every intermediate state and play them out in slow motion. The user wants to see the *latest* state, not a replay of the in-between frames.

`RenderCoalescer` is a one-deep queue: while one render is in flight, the next `schedule(...)` replaces any previously queued item. When the in-flight render finishes, it picks up the most recently queued item and starts rendering that.

```ts
import { RenderCoalescer } from "g2-kit/ui";

const coalescer = new RenderCoalescer<WireScreen>({
  render: async (screen) => { await renderScreen(screen); },
  onError: (err) => console.error("render error", err),
});

// From the event handler:
coalescer.schedule(latestScreen);
```

One-deep on purpose. Catching up to the latest state matters more than preserving every intermediate frame.

## What's NOT here

- No reconnection strategy. Bring your own.
- No app-level state machine. The cmux bridge's sleep/wake/settings-menu logic is deliberately cmux-specific.
- No BLE transport. That's in [`g2-kit/ble`](../ble).

## Examples

See [`../examples/`](../examples) for runnable demos combining `ble` and `ui`.
