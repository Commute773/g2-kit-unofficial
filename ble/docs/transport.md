# Transport — BLE GATT layout

## Two arms, two peripherals

Each pair of G2 glasses is **two independent BLE peripherals**: the left arm and
the right arm. They advertise as separate devices with names ending in `_L_…`
and `_R_…`. There is **no internal bus between them** — if you want both lenses
to do something, you talk to both arms yourself.

For most things we only use the **right arm**:

- It is the only arm that sends async events (container taps, state changes).
- It owns the lens the user looks at for UI.
- The L arm is silent on async channels and is mostly only useful for a
  secondary render + the left-side mic.

The `session.ts` helper in this library exposes the right arm by default.
Dual-arm work is rare enough that it is left as direct `ble.ts` usage.

## GATT services we touch

| Service UUID | Purpose | Notes |
|---|---|---|
| `6E40FFF0-B5A3-F393-E0A9-E50E24DCCA9E` (shortened `fff0`) | Command channel | write char `fff2`, notify char `fff1`. Everything in this library runs through here. |
| `6450` (custom, discovered by RE) | Audio mic stream | LC3-encoded PCM frames, 205 bytes per BLE notification. Only active after an `AudioCtrCmd` enable. Distinct from the command channel. |
| `7450` (custom) | Initially suspected audio path | Wrong — `7450` is not the mic; audio arrives on `6450`. Documented here so future tracing doesn't repeat the mistake. |

The `BleG2PsType` field in the firmware dispatch table maps service → handler:
`type=2` is the audio stream handler, which is what puts mic frames on `6450`.

## Characteristic use

On the `fff0` command service:

- **fff2** — write-without-response. Host → glasses. This is where framed
  EvenHub envelopes get sent. Fragment at `mtu - 3` (typically `244 − 3 = 241`
  payload bytes).
- **fff1** — notify. Glasses → host. Acks, async events, and multi-fragment
  replies come back here. The library's `session.ts` collects fragments by
  their envelope `seq` byte (see `envelope.md`) and re-emits whole messages.

Notifications arrive out-of-order relative to writes — an ack for write N may
appear after an unrelated async event. Always match on `magic` / `seq`, never
on timing.

## `@stoprocent/noble` MaxListeners leak

`noble` emits `data` events from each characteristic and does not prune
listeners when you rebind. In long-running sessions (reconnects, scans) we
routinely hit the default `MaxListeners=10` cap and the process starts logging
warnings.

Workaround: bump the listener cap on the characteristics when you subscribe,
and never re-subscribe without unsubscribing first.

```ts
char.setMaxListeners(32);
```

This is done inside `session.ts` for us. If you go direct to `ble.ts` you have
to do it yourself.

## Scan / connect timing

Scan → connect → discover services → discover characteristics → subscribe to
notify → session prelude (see `sids.md`) takes about **1.2–1.8 s** in the
common case. If it's taking longer than 3 s, either the peripheral is
advertising but the connection is failing (try again) or the OS is holding a
stale handle from a previous session (kill the noble process and retry — noble
does not always release on `disconnect()`).
