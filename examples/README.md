# g2-kit examples

Runnable demos for the two libraries. All examples are self-contained Bun scripts — no build step, no bundler. Run any of them with:

```bash
bun examples/<name>.ts
```

The glasses must be on, unpaired from any other host (Mirai / phone), and within BLE range (~3 m).

## Start here

| | File | What it does |
|---|---|---|
| 1 | **`scan.ts`** | Generic BLE scanner. Lists every advertising device for 15 s. Use this to sanity-check that noble is working before trying anything else. |
| 2 | **`find-glasses.ts`** | Scan specifically for G2 arms and print `L` / `R` as they come in. If both arms show up here, `G2Session.open()` should succeed. |
| 3 | **`connect.ts`** | Minimal session: scan → connect → prelude → read device settings → disconnect. The "does my whole stack work" diagnostic. |

If any of these three fail, fix that before trying anything else.

## Rendering

| File | What it does |
|---|---|
| **`hello-text.ts`** | Text container with a live countdown. Exercises CREATE + heartbeat + repeated UPDATE. |
| **`list-taps.ts`** | Interactive menu. CREATE + REBUILD a list, subscribe to tap events, react. |
| **`pager.ts`** | Long list paginated through `g2-kit/ui`'s pager, with ▲ Prev / ▼ Next nav rows. |
| **`image.ts`** | Procedurally-generated images pushed through `G2ImageStreamer`. Exercises the full image pipeline — first-stream warmup, sliding-window Cmd=3, dedup. |

## Audio

| File | What it does |
|---|---|
| **`mic-stream.ts`** | Enable mic, receive LC3 packets for 10 s, decode to 16 kHz mono PCM, optionally write a `.pcm` file you can play with `ffplay`. |

## Under the hood

Every example follows roughly the same shape:

```ts
import { G2Session, buildCreateStartUpPageContainer, ... } from "g2-kit/ble";
import { startHeartbeat } from "g2-kit/ui";

let magic = 100;
const nextMagic = () => (magic = magic >= 255 ? 100 : magic + 1);

const session = await G2Session.open();

// 1. CREATE a container (first CREATE must ack).
const create = buildCreateStartUpPageContainer({ name, items, magic: nextMagic() });
await session.sendPb(0xe0, create.pb, create.magic);

// 2. Start the heartbeat (gate it on firstCreateDone in real code).
const hb = startHeartbeat({ session, nextMagic });

// 3. Do your thing — REBUILD with Cmd=7, subscribe to events, stream audio, ...

// 4. Tear down.
hb.stop();
await session.close();
```

The library does NOT auto-start the heartbeat. You own it. The `nextMagic` closure stays in userland for the same reason — this way if you want to share a magic counter across multiple subsystems (as the cmux bridge does) you can.

## The magic counter

Every ack-able write carries a `magic` value that the glasses echo back. On some firmware paths the `magic` byte is effectively uint8 — values ≥256 silently never ack. Keep `magic` in the range 100..255 and cycle:

```ts
let magic = 100;
const nextMagic = () => (magic = magic >= 255 ? 100 : magic + 1);
```

All examples use this exact pattern.

## Troubleshooting

**`g2-find timeout`** — the scanner didn't see both arms. Check:
- Glasses are on (there's no on/off switch; folding them sleeps them, unfolding wakes them)
- Not paired with Mirai or another phone (will take the BLE slot exclusively)
- In range; noble's effective range is ~3 m
- Bluetooth permissions on macOS (System Settings → Privacy → Bluetooth → your terminal)

**`CREATE did not ack`** — another session is still live, OR you re-ran the example with the same container name but didn't reconnect. Kill any stale node processes, wait 5 s, retry. Subsequent CREATEs of the same name in the same session are silent by design (see `ble/docs/containers.md`).

**Warning about `MaxListenersExceededWarning`** — noble leaks `data` listeners. The library bumps the cap internally in `connectArm`; if you see this warning you're using the raw noble API somewhere bypassing the wrapper.

See [`../ble/docs/gotchas.md`](../ble/docs/gotchas.md) for the full foot-gun list.
