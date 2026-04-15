# Envelope framing

Every byte you send to the glasses on `fff2`, and every byte you get back on
`fff1`, is wrapped in an EvenHub envelope. The framing is implemented in
`envelope.ts` (build) and `session.ts` (reassembly); this doc describes the
wire layout.

## Header

```
aa 21 LL LL SS FF II MM MM MM MM  <payload...>  CC CC
 │  │  │     │  │  │  │           │             │
 │  │  │     │  │  │  │           │             └── CRC-16/CCITT-FALSE over
 │  │  │     │  │  │  │           │                  everything from aa through
 │  │  │     │  │  │  │           │                  end of payload
 │  │  │     │  │  │  │           └── payload bytes
 │  │  │     │  │  │  └── 4-byte magic (little-endian uint32). Clients echo
 │  │  │     │  │  │      this in ack frames so you can match write→ack.
 │  │  │     │  │  └── 1-byte fragment `seq` group. SAME byte value for every
 │  │  │     │  │      fragment of one logical message (see below). Not a
 │  │  │     │  │      sequence counter, not an index — it's a *group key*.
 │  │  │     │  └── 1-byte flag. 0x00 = request, 0x01 = async event /
 │  │  │     │      indication, other values are subsystem-specific.
 │  │  │     └── 1-byte sid (subsystem id). See `sids.md`.
 │  │  └── 2-byte payload length, little-endian. Counts only the inner payload
 │  │      bytes — header and CRC are NOT included.
 │  └── framing byte 0x21 (always).
 └── start-of-frame 0xaa (always).
```

`0xaa 0x21` is the fixed preamble and how you re-sync if the notify stream
drops a byte. The parser in `session.ts` scans for it, validates length, and
checks the CRC — any of `aa`, `21`, length, or CRC failing means "drop the
frame, wait for the next `aa 21`".

## CRC-16/CCITT-FALSE

- Poly `0x1021`
- Init `0xFFFF`
- No reflect in, no reflect out
- No final XOR

Computed over every byte from the leading `0xaa` through the last byte of
payload, written big-endian at the end.

`crc.ts` has a tested implementation. If you roll your own, the fastest way to
verify correctness is to send a known 0-length sid=0xe0 Cmd=12 heartbeat and
confirm the glasses ack it — they will silently drop anything with a bad CRC.

## Fragmentation and the `seq` rule

BLE write-without-response on this firmware caps out at `mtu - 3` payload
bytes (typically **241** with the 244-byte MTU we negotiate). Any message
longer than that has to be split across multiple writes.

**The `seq` byte is constant across every fragment of one logical message.**
This is the single most important rule in the envelope. It does not
increment. It does not restart. It is a group key that tells the firmware
"these N writes belong to one message, reassemble them".

Practically, each new logical message picks a fresh `seq` value (we cycle
through a counter), and every fragment of that message stamps the same value.
The firmware buffers until it has received `LL` bytes total with that `seq`,
then dispatches.

If you increment `seq` per fragment (intuitive, wrong), the firmware treats
each fragment as a separate malformed message and drops all of them. This is
the number-one failure mode when implementing the envelope from scratch.

Reassembly on the host side mirrors this: the parser buffers by `seq` and
flushes once `LL` bytes have been received. `session.ts` handles this.

## `magic` and ack correlation

The 4-byte `magic` field is the host's request ID. When you send a request
(flag=0x00), the glasses reply on `fff1` with a frame that echoes your
`magic` back — that's how you know which reply goes with which write.

**Cap:** only the **lowest byte of `magic` is effectively used** as a
uint8 by the firmware. Values ≥256 are silently dropped on some subsystems
(notably sid=0xe0 Cmd=0 CreateStartUpPage) — the firmware sees `magic & 0xff`
and your ack never comes.

Workaround: cycle `magic` as a uint8 (`magic = (magic + 1) & 0xff`), or keep
it small (`< 128`). The `nextMagic` counters in this library do exactly this.

## Async events

Frames with `flag=0x01` are async notifications from the glasses — container
taps, state changes, sensor events. They are NOT replies to your writes, and
their `magic` is whatever the firmware chose (usually 0). Match on `sid` +
`Cmd`, not on `magic`.

See `events.md` for the event catalog.
