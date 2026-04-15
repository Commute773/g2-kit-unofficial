# g2-kit/ble

Layer 1: pure BLE transport and EvenHub protocol for the Even Realities G2 smart glasses.

Everything in this package is side-effect-free on import. It gives you the primitives you need to talk to the glasses — session management across the L/R arm architecture, envelope framing with CRC validation, protobuf message builders for every EvenHub command we've mapped, an LC3 mic decoder, and raw-image tiling helpers.

No UI. No app logic. No opinion on pagination or rendering cadence — that's what [`g2-kit/ui`](../ui) is for.

## Protocol docs

Start at **[`docs/README.md`](./docs/README.md)**. Eleven files, ~1100 lines:

- `transport.md` — GATT layout, L/R arms, noble quirks
- `envelope.md` — `aa 21` framing, CRC-16/CCITT-FALSE, fragment `seq` rule
- `sids.md` — subsystem IDs + session prelude
- `evenhub-commands.md` — sid=0xe0 Cmd table + proto shapes
- `containers.md` — CREATE/UPDATE/REBUILD lifecycle
- `images.md` — 4bpp format, tiling, streaming pipeline, warmup
- `text.md` — 50×10 grid, capture gotcha, sys-event click routing
- `audio.md` — LC3 on service 6450, AudioCtrCmd enable flow
- `settings.md` — sid=0x09 G2SettingPackage
- `events.md` — async event channel
- `gotchas.md` — condensed foot-gun list

If you're reverse-engineering your own integration, the docs are the source of truth.

## Modules

| File | Exports | Purpose |
|---|---|---|
| `session.ts` | `G2Session`, `G2SessionOptions` | High-level scan + connect + prelude + send/ack wrapper |
| `ble.ts` | `findBothArms`, `connectArm`, `waitForAck`, `sendFrames`, `onFrame`, `onRender`, `ArmHandles`, char UUIDs | Low-level Noble wiring for both arms |
| `envelope.ts` | `framePb`, `parseFrame`, `FLAG_REQUEST`, `ParsedFrame` | Envelope encode/decode with CRC + seq fragmentation |
| `crc.ts` | `crc16CcittFalse` | CRC-16/CCITT-FALSE implementation (tested) |
| `messages.ts` | `buildCreateStartUpPageContainer`, `buildUpdateListContainer`, `buildUpdateTextContainer`, `buildHeartbeat`, `buildShutDown`, prelude constants | EvenHub protobuf builders |
| `events.ts` | `decodeAsyncEvent`, `DecodedEvent`, `OsEventTypeList` | Async-event dispatch & decoding |
| `settings.ts` | `buildSettingsQuery`, `buildBrightnessSet`, etc. | sid=0x09 G2SettingPackage helpers |
| `audio.ts` | `AudioCapture` | High-level mic subscription (handles Cmd=18 enable + decoder bridge) |
| `lc3-decoder.ts` | `G2AudioDecoder` | LC3 → 16 kHz mono PCM decoder |
| `image.ts` | `build4bppBmp`, `planImageFragments`, tile-size helpers | 4bpp image packing + tiling |
| `gen/` | Generated protobuf types | Output of `buf generate` against the `.proto` files in `~/g2-re/` |

## The session

`G2Session.open()` is the happy-path entry point. It scans for both arms, connects, runs the mandatory session prelude, and hands back a session object. For most use-cases you never touch `ble.ts` directly.

```ts
import { G2Session } from "g2-kit/ble";

const session = await G2Session.open({
  // sendPrelude: true,      // default — set false only if you're replaying captures
  // preludeTimeoutMs: 5000,
  // quiet: false,
});

// Send a protobuf payload on any sid, wait for the ack.
await session.sendPb(0xe0, bytes, magic, { ackTimeoutMs: 2000 });

// Subscribe to async events (right arm only — L is silent).
const off = session.onEvent((ev, frame) => { /* ... */ });

await session.close();
```

The `sendPbPipelined` variant registers the ack waiter but does NOT await it — used by the image streamer to run a sliding-window Cmd=3 pipeline. See [`ui/image-streamer.ts`](../ui/image-streamer.ts).

## Magic counter

Every ack-able write carries a `magic` value that the glasses echo back. The firmware treats `magic` as **effectively uint8** on some code paths, so keep it in the range 100..255 and cycle:

```ts
let magic = 100;
const nextMagic = () => (magic = magic >= 255 ? 100 : magic + 1);
```

Values ≥256 silently never ack. This is documented in `docs/envelope.md`.

## What's NOT in this package

- No pager, no virtual list. Use [`g2-kit/ui`](../ui) or roll your own.
- No render coalescing / rate-limiting. The firmware can't handle concurrent Cmd=7 writes, so serialize renders yourself or use `g2-kit/ui`'s `RenderCoalescer`.
- No image streaming pipeline. Raw `buildUpdateImageContainer` + `planImageFragments` are exported, but the sliding-window + first-stream warmup logic lives in `g2-kit/ui`'s `G2ImageStreamer`.
- No reconnection logic. If the BLE link drops, call `G2Session.open()` again.
- No settings menu state machine. That's cmux-specific and lives in `cmux/glasses/settings-menu.ts`.

## Examples

See the top-level [`examples/`](../examples) folder for runnable demos, including a standalone `scan.ts` that just lists nearby BLE devices without connecting.
