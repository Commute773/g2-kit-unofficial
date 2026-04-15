# g2-kit (unofficial)

> **Disclaimer:** this is what I personally use, it's not guaranteed to be correct, I am a dumb software engineer having fun.

Two libraries for talking to the [Even Realities G2 smart glasses](https://www.evenrealities.com/), reverse-engineered from scratch. No EvenHub SDK, no vendor blobs — just the wire protocol.

- **[`g2-kit/ble`](./ble)** — pure BLE transport: Noble-based session for the L/R arm architecture, `aa 21` envelope framing (CRC-16/CCITT-FALSE), EvenHub protobuf message builders, LC3 mic decoder, raw-image tiling. No UI or app-level concerns.
- **[`g2-kit/ui`](./ui)** — app-level abstractions built on top: list pagination, image stream with sliding-window pipelining + first-stream warmup, heartbeat driver, render coalescer.

The protocol documentation lives in **[`ble/docs/`](./ble/docs)** — eleven files covering envelope framing, container lifecycle, the image pipeline, text quirks, audio, events, and every gotcha we hit along the way. If you're implementing your own G2 integration, start there.

Runtime: [Bun](https://bun.sh/). Works on Node 22+ with minor tweaks (swap `Buffer.from` usage if you care).

## Install

```bash
bun add g2-kit
# or, as a sibling folder consumer:
#   import { G2Session } from "../g2-kit/ble";
```

Requires `@stoprocent/noble` at runtime (peer dep).

## Hello, lens

```ts
import { G2Session, buildUpdateTextContainer, buildCreateStartUpPageContainer } from "g2-kit/ble";
import { startHeartbeat } from "g2-kit/ui";

const session = await G2Session.open();

let magic = 100;
const nextMagic = () => (magic = magic >= 255 ? 100 : magic + 1);

// First CREATE must ack; later CREATEs of the same name are fire-and-forget.
const create = buildCreateStartUpPageContainer({
  name: "hello",
  items: ["hello, lens"],
  magic: nextMagic(),
});
await session.sendPb(0xe0, create.pb, create.magic);

// Keep the plugin task alive.
const hb = startHeartbeat({ session, nextMagic });

// Paint some actual text.
const text = buildUpdateTextContainer({
  name: "hello",
  text: "hello, lens",
  captureEvents: true,
  magic: nextMagic(),
});
await session.sendPb(0xe0, text.pb, text.magic);

await new Promise((r) => setTimeout(r, 5000));
hb.stop();
await session.close();
```

See [`examples/`](./examples) for runnable versions of the above plus:

- **`scan.ts`** — generic BLE scanner (anything nearby, not just G2)
- **`find-glasses.ts`** — scan specifically for G2 arms and print RSSI/UUID
- **`connect.ts`** — minimal session open → read battery → close
- **`hello-text.ts`** — text container with a live timer
- **`list-taps.ts`** — interactive list with tap handling
- **`image.ts`** — push a 1-bit bitmap to the lens
- **`mic-stream.ts`** — stream LC3 mic audio and decode to PCM

Run any of them with `bun examples/<name>.ts`.

## Layout

```
g2-kit/
├── ble/          ← Layer 1: BLE transport + protocol
│   ├── docs/     ← compiled protocol notes (start here)
│   └── README.md
├── ui/           ← Layer 2: pager, image streamer, heartbeat, coalescer
│   └── README.md
└── examples/     ← runnable demos
```

The glasses-facing side of the [cmux](https://github.com/Commute773/cmux) tmux frontend consumes both libraries and is the reference real-world consumer — it lives at `cmux/glasses/bridge.ts`, not in this repo.

## Status

Extracted out of a working cmux integration. APIs are settling but still pre-1.0 — expect minor breakage on version bumps. The wire protocol itself is stable (it's reverse-engineered from shipping firmware).

Everything here has been verified on real hardware. Where the firmware has a bug, the library works around it and the workaround is named in `ble/docs/gotchas.md`.

## License

MIT.
