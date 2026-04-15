# Async events

Async (unsolicited) frames arrive on the notify characteristic with
`flag=0x01` in the envelope. They do NOT carry a host-assigned `magic` and
are never replies to a specific write — match on `sid` + `Cmd` + payload
shape.

Two sids carry events we care about:

- **`0xe0` flag=0x01** — EvenHub events (container taps, system clicks,
  audio stream acks).
- **`0x0d`** — state-change events (cross-subsystem device state: wear
  detect, head-up transitions, mode changes).

## Container press — sid=0xe0 flag=0x01 Cmd=0

Fired when the user taps on a **list or image container** with capture
enabled. NOT fired for text containers — those route through the system
CLICK_EVENT, see below.

Payload:

```
ContainerEvent {
  string name    = 1;   // container name that was tapped
  uint32 index   = 2;   // which row/tile; for lists this is the row index
  uint32 tag     = 3;   // echoed from ListItem.tag on the tapped row
  uint32 status  = 4;   // see status codes
}
```

`tag` is the best way to map back to your logical row — we set it when we
build the list and match it when we get the event, so we don't have to
maintain index-to-item tables.

### Status codes

| Code | Meaning |
|---|---|
| `0` | Normal press |
| `1` | Long press (>500 ms) |
| `2` | Release after press (rare; most callers ignore) |

Most code only cares about `status=0` for normal taps. Long-press is the
discoverable way to open a row's context menu.

## System CLICK_EVENT — sid=0xe0 flag=0x01 Cmd=<system>

This is the channel text-container taps route through. Layout:

- Different Cmd code from container-press.
- Payload identifies "a click happened" but does **not** include the
  container name — you can't disambiguate which text container was tapped.

The bridge handles this by only ever having one text container visible at
a time (two-names flip-flop), so every system click is unambiguously "for
the currently-shown text container".

`project_g2_text_container_taps.md` in memory has the original trace.

## Audio stream ack — sid=0xe0 flag=0x01 Cmd=19

`AudioCtrRes` — reply to `Cmd=18 AudioCtrCmd`. Contains `action` echoed back
and a result code. See `audio.md`.

## State change — sid=0x0d flag=0x01

The device-wide state channel. Events include:

- **Wear detect on/off** — the user put on or took off the glasses.
- **Head-up state change** — the user tilted their head into or out of the
  configured "looking at lens" angle.
- **Sleep / wake** — firmware entered or exited low-power mode.
- **Charging state change** — plug / unplug of the charging cable.

The payload is a small enum + a state bit, plus a timestamp. `events.ts` in
this library normalizes them into a discriminated union; downstream code
pattern-matches on `kind`.

## Left arm is silent on async

The **left arm does not emit async events.** It will happily accept
heartbeats and renders, but wear-detect, container taps, and state changes
only ever come through the right-arm notify characteristic. Subscribe to
the right arm for events, always.

This is not documented anywhere in the firmware — it's empirical and
consistent across every session we've captured. If you need events and
connect to the left arm by accident, you will think your subscription is
broken.
