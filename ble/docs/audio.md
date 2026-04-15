# Audio — mic stream (LC3 over BLE)

The G2 mic is a one-way pipeline: glasses → host, LC3-encoded PCM, 16 kHz
mono. It does NOT run on the command channel — it has its own BLE service
and notification stream, separate from EvenHub.

## Service routing

- **Service `6450`** — mic stream. `BleG2PsType` field in the firmware
  dispatch table is `2` for this service. LC3 frames arrive as notify
  bursts on a characteristic under this service.
- Not `7450`. The original trace guessed `7450` and it was wrong.
  `7450` is a different service entirely.

The `audio.ts` module in this library subscribes to the mic characteristic
and yields raw LC3 frames to the caller.

## Enable/disable — Cmd=18 AudioCtrCmd

The mic is off by default. To turn it on, send an EvenHub Cmd=18
AudioCtrCmd on sid=0xe0:

```
AudioCtrCmd {
  action: 1,   // 1 = start, 0 = stop
}
```

The glasses reply with **Cmd=19 AudioCtrRes** (flag=0x01 async) once the
stream is actually armed. Wait for this before you start expecting data on
the mic characteristic — if you don't, you miss the first ~100 ms.

To stop, send the same Cmd=18 with `action=0`. Without an explicit stop the
mic keeps streaming until the plugin task dies, which drains battery fast.

## Frame format on the mic characteristic

Each BLE notification on the mic characteristic is **205 bytes** and has a
2-byte header prefix plus an LC3 frame:

```
[ header (2 bytes) ][ LC3 frame (203 bytes) ]
```

Header byte layout (empirical):

- Byte 0: `0xCC` for a normal frame, `0xCD` for the first frame of a new
  session / after a resync. Treat `0xCD` as "reset your decoder state".
- Byte 1: a sequence counter modulo 256. Useful for detecting dropped frames.

The 203-byte LC3 payload decodes to a **20 ms chunk of 16 kHz mono PCM**, so
one BLE notification = 20 ms of audio = 320 samples. At 205 B per 20 ms
that's ~10 KB/s — well within BLE bandwidth.

## Decoding

`lc3-decoder.ts` in this library wraps a small LC3 decoder and emits PCM.
Every notification is one 20 ms decode; downstream callers can stream the
PCM into an ASR, a WAV file, or their own processing pipeline.

The cmux bridge uses this to feed Moonshine medium-streaming for live
transcription — see `project_g2_moonshine_asr.md` in memory for the full
pipeline.

## Dual-arm note

Each arm has its own mic, and each arm advertises service `6450`
independently. To use both mics simultaneously you have to connect to both
arms as separate noble peripherals and subscribe to each. For single-mic
use we prefer the right arm (it's the "primary" arm for UI already) but the
left arm's mic is arguably slightly higher SNR on the speech range — pick
based on what you're doing.

## Gotcha — plugin task lifecycle

The mic stream is tied to the plugin task. If heartbeats stop and the
firmware tears the plugin task down, **mic frames stop**, even though the
BLE subscription is still live and noble will not notify you. You'll sit
there waiting for audio that never comes.

Keep heartbeats running for the entire duration you want mic data. If you
see mic frames stop unexpectedly, check whether the heartbeat loop died.
