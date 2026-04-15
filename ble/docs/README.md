# G2 BLE protocol notes

Compiled notes from reverse-engineering the Even Realities G2 smart glasses. These
documents describe the wire protocol that `g2-kit/ble` implements; each doc is
scoped to one layer of the stack.

The goal is to be concrete enough that you can reproduce any of the working
behaviors from scratch — without the EvenHub SDK, without strings in the app,
just raw BLE writes.

## Index

- [transport.md](transport.md) — BLE GATT layout (L/R arms), services, noble quirks, L-arm silent asymmetry.
- [envelope.md](envelope.md) — `aa 21 …` framing, CRC-16/CCITT-FALSE, per-message `seq` fragment grouping, MTU split.
- [sids.md](sids.md) — subsystem IDs (0x01, 0x06, 0x08, 0x09, 0x0d, 0x0e, 0x80, 0xe0) and the two-message session prelude.
- [evenhub-commands.md](evenhub-commands.md) — sid=0xe0 `Cmd` table (0/3/7/9/12/18/19) and the protobuf field shapes each one uses.
- [containers.md](containers.md) — CREATE/UPDATE/REBUILD lifecycle, name cap, subsequent-CREATE no-ack rule, two-names shape transitions, blank-lens soft sleep.
- [images.md](images.md) — 4 bpp BMP palette, tiling, first-stream-dropped bug + warmup, sliding-window Cmd=3 pipeline, ack-miss tolerance, throughput.
- [text.md](text.md) — TextContainerConfig layout, 50×10 grid, proportional font, auto-wrap/scroll bar, content cap, `captureEvents` default-off gotcha.
- [audio.md](audio.md) — LC3 mic stream on service 6450, 0xCC/0xCD frame prefix, AudioCtrCmd enable flow, 205-byte packet shape.
- [settings.md](settings.md) — sid=0x09 G2SettingPackage query/set shapes (battery, brightness, wear, silent mode, head-up, x/y coords).
- [events.md](events.md) — async event channel: sid=0xe0 flag=0x01 container-press frames, sid=0x0d cross-subsystem state changes.
- [gotchas.md](gotchas.md) — list of foot-guns you will otherwise find the hard way.

## Status

Everything here has been observed on-lens and verified with a live probe. Where
something is suspected but not confirmed, it's flagged explicitly. Where the
firmware has an outright bug that the library works around, the workaround is
named in the relevant doc.

## See also

- `~/g2-re/` — the curated research archive (captures, proto files, hex dumps).
- `~/bletools/` — live-edit probe/writer scripts that exercise everything here.
