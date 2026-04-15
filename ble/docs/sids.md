# Subsystem IDs (sid)

The second byte of the envelope's inner header is the `sid` — "subsystem id".
It selects which handler on the firmware receives the payload. We have
confirmed the following:

| sid | Name | Payload | Used for |
|---|---|---|---|
| `0x01` | app-launch | protobuf | Session prelude, app lifecycle on the glasses side. |
| `0x06` | teleprompt | protobuf | Teleprompter mini-app (scroll a block of text). Not used by this library's main path but kept in `messages.ts` for completeness. |
| `0x08` | nav | protobuf | Turn-by-turn navigation mini-app. Not wired through this library. |
| `0x09` | g2_setting | protobuf `G2SettingPackage` | Read/write device settings (battery, brightness, wear-detect, silent, head-up, x/y lens coords). See `settings.md`. |
| `0x0d` | state-change | protobuf | Async cross-subsystem state events (device wake/sleep, mode change, etc.). Async-only, flag=0x01. |
| `0x0e` | widget-transform | protobuf | Animated widget transforms. Rarely used by us. |
| `0x80` | dev_config | protobuf | Developer/debug config. Avoid poking at this without a reason. |
| `0xe0` | **EvenHub** | protobuf `EvenHub` wrapper | **The main render/UI channel.** Everything about containers, images, text, audio, heartbeat runs through here. See `evenhub-commands.md`. |

## Session prelude (mandatory)

Before the glasses will accept any EvenHub traffic on sid=0xe0, you must send
a two-message prelude. This was discovered the hard way — the firmware
silently ignores all Cmd=0/3/7 etc. until the prelude is complete.

**Step 1: sid=0x01 type=2** — "app launch"

Protobuf shape (from `messages.ts`):

```
AppLaunchRequest { type: 2 }
```

Send as sid=0x01, flag=0x00, new `magic`. Wait for ack.

**Step 2: sid=0xe0 type=0 CreateStartUpPage** — the initial "home screen"
container, even if you don't intend to use it. This primes the plugin task so
subsequent Cmd=7 / Cmd=3 writes are dispatched.

Both the library's `session.ts` and the cmux bridge do this automatically at
connect time. If you go direct to `ble.ts` you have to do it yourself, or the
first render you try will silently do nothing.

## Why `0xe0`?

EvenHub is the firmware's generic UI / rendering subsystem and the single
most overloaded sid by far. Inside the `0xe0` envelope the payload is a
protobuf with a top-level `Cmd` enum that selects the sub-operation — see
`evenhub-commands.md`. Treat sid=0xe0 + Cmd as if it were a two-level
addressing scheme.
