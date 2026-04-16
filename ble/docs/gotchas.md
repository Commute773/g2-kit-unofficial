# Gotchas — things the firmware does not tell you

A running list of foot-guns. Every entry here cost at least one debugging
session the first time we hit it.

## Envelope

**Fragment `seq` is a group key, not a counter.** Every fragment of one
logical message uses the same `seq` byte. Incrementing `seq` per fragment
(the intuitive thing) makes the firmware drop every fragment as a broken
standalone message. See `envelope.md`.

**`magic` is effectively uint8.** The `magic` field is 4 bytes on the wire
but the firmware compares only the low byte in at least some paths
(notably sid=0xe0 Cmd=0 CreateStartUpPage). Keep `magic < 256`, or cycle
it as a uint8, or some acks will never arrive.

**CRC-16/CCITT-FALSE, no reflect, no final XOR.** Every common CRC-16
variant gets silently dropped. Test with a Cmd=12 heartbeat — if you get
an ack, your CRC is right.

## Session

**Session prelude is mandatory.** sid=0x01 AppLaunch type=2 + sid=0xe0
CreateStartUpPage, in that order, before anything else. Without this, all
your Cmd=7/Cmd=3 writes are silently dropped.

**Subsequent Cmd=0 CreateStartUpPage for the same name does NOT ack.**
First CREATE acks. Any CREATE after that — for the same name — is accepted
internally but produces no ack frame. If you block waiting for it you hang
forever. Track created-names flags and use Cmd=7 UPDATE after the first
CREATE.

**Container shape transitions need a new name.** You cannot UPDATE a list
container into a text container. Use two names ("list-a" and "list-b" or
"text-a" and "text-b") and flip between them for shape changes.

## Images

**First stream after CREATE is silently dropped.** The fragments ack, the
render command fires, the lens stays blank. Push a sacrificial warmup
frame first (all-zero or a flat splash) and treat the second frame as your
real first frame.

**4 KB soft cap per Cmd=3 fragment.** Bigger fragments are silently
dropped. Stay at ≤3800 B to be safe.

**Stuck-session trap.** After an aborted stream, re-creating the container
with an adjacent MapSessionId inherits the failed state — the "new"
session gets the old buffers. Bump the session counter by 2 on reset.

**Ack-miss tolerance.** Occasionally a Cmd=3 ack never comes even though
the fragment landed. If you treat it as fatal you drop frames that
actually rendered. Tolerate up to ~3 consecutive misses before giving up.

## Text

**`capture_events` defaults to `false` on TextContainer.** No taps fire
unless you set it explicitly. Only TextContainer has this default; lists
and images capture by default.

**Text taps route through the system CLICK_EVENT, not container-press.**
You get "a click happened somewhere in the text area" but NOT which text
container (if you have more than one visible). Workaround: only one text
container on screen at a time.

**Content cap ~1000 bytes per TextContainer.** Larger content renders as
truncated or empty. Paginate on the host.

**No font-size API.** The LVGL font shipped in the firmware is what you
get. Plan layouts against the empirical 50×10 grid.

## Heartbeat

**No heartbeats before the first CREATE.** The plugin task doesn't exist
yet; the heartbeat goes to the void. Use `shouldBeat: () => firstCreateDone`
on the startHeartbeat helper.

**Plugin task dies after ~10 s without traffic.** Keep the 5 s heartbeat
running for the lifetime of your session, including while mic-streaming —
if heartbeats stop, the mic stream silently stops too.

## Write serialization

**Multi-fragment messages must not interleave on the BLE characteristic.**
The firmware has a single reassembly buffer keyed by the transport `seq`
byte. If a heartbeat (1 fragment) lands in the middle of a 3-fragment
REBUILD, the REBUILD's reassembly is corrupted. After enough corruptions
the plugin task wedges — it still acks heartbeats but silently stops
routing tap events.

`sendFrames()` and `G2Session.sendPb()` serialize writes automatically
via `withWriteLock()`. If you build your own transport (e.g. proxying BLE
through a phone), use the same lock:

```ts
import { withWriteLock, type WriteLockHolder } from "g2-kit/ble";

const arm: WriteLockHolder = { writeLock: Promise.resolve() };

await withWriteLock(arm, async () => {
  for (const f of frames) await writeOneFragment(f);
});
```

## Arms

**Left arm is silent on async events.** Wear detection, container taps,
state changes — all come from the right arm only. Subscribe to the right
arm for events. Using the left arm will make you think your notify
subscription is broken.

**L-arm silence is not documented in the firmware.** Empirical,
consistent across every capture. Don't waste time looking for a config
bit to enable it.

## Noble

**`@stoprocent/noble` leaks `data` listeners.** The default
`MaxListeners=10` cap warns on long-running sessions. Bump the cap on each
characteristic you subscribe to (`char.setMaxListeners(32)`) and never
re-subscribe without unsubscribing first.

**Noble does not always release on `disconnect()`.** If reconnects hang,
the OS still thinks you're connected. Fastest recovery is to kill the
node process and let the OS drop the link.

## Services

**Audio is on service `6450`, not `7450`.** The original trace guessed
wrong. `BleG2PsType=2` is the dispatch field if you're ever re-verifying
this from the firmware dispatch table.

## Settings

**sid=0x80 (`dev_config`) is dangerous.** Developer / debug fields. One
early RE session non-terminally bricked a pair by writing an unknown
`dev_config` field — required power-cycle + re-pair to recover. Stay on
sid=0x09 for user-facing settings unless you know exactly what you're
doing.

## Container names

**Name cap is 14 characters, hard.** 15+ character names are silently
rejected. No error, no render.

**Names are case-sensitive identities.** `"list"` and `"List"` are two
different containers.
