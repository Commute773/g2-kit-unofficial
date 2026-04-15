# Device settings (sid=0x09 G2SettingPackage)

`sid=0x09` is the device-settings subsystem. You read and write a single
`G2SettingPackage` protobuf with many optional fields — every field you
include is either a query or a set, depending on which sub-field is
populated.

## Wire shape

```
G2SettingPackage {
  optional BatterySetting      battery       = 1;
  optional BrightnessSetting   brightness    = 2;
  optional WearDetectSetting   wear_detect   = 3;
  optional SilentModeSetting   silent_mode   = 4;
  optional HeadUpSetting       head_up       = 5;
  optional LensCoordSetting    lens_coord    = 6;
  // ...more fields exist in the firmware but aren't exercised by this library
}
```

Each subfield has a `query` variant (empty / flag only) and a `set` variant
(new value). Send flag=0x00 with a query variant to read, flag=0x00 with a
set variant to write. Both get an ack echoing the current value.

`settings.ts` in this library wraps the common reads (battery, brightness,
wear) and writes (brightness set, silent mode toggle).

## Per-field notes

### Battery

- Read-only. Returns percent (0–100) per arm. Left and right arms are
  independent batteries and will drift from each other — always show both
  separately.
- Updates roughly every minute internally; reading more often is pointless.

### Brightness

- 0–100 scale.
- The mapping to actual lens brightness is nonlinear — 30 looks dim but
  readable, 60 is bright outdoors, 100 is "uncomfortable but legible in
  direct sunlight".
- Setting brightness = 0 turns the lens off visually but does NOT enter any
  power-saving mode. Prefer the blank-lens trick (see `containers.md`) for
  soft sleep.

### Wear detection

- Proximity sensor on the nose bridge.
- When worn and unworn transition, the glasses emit a sid=0x0d state-change
  async event (see `events.md`).
- Can be read as a boolean or subscribed to via events. Prefer events —
  polling wastes traffic.

### Silent mode

- Suppresses the audio cue on container pushes and notifications.
- Boolean.

### Head-up detection

- Accelerometer-based. When the user's head is tilted forward (looking
  down at the lens), the glasses emit a wake event; when tilted back, a
  sleep event.
- Configurable thresholds (angle + dwell time) via the set variant.
- Used by the bridge for the auto-wake behavior: lens activates when the
  user looks down, deactivates after N seconds of looking forward.

### Lens coord (x/y offset)

- Fine lens-centering calibration. The firmware stores an `x, y` offset
  applied to every rendered frame so the user can nudge the image to align
  with their IPD / where the lens physically sits on their face.
- Range is small (~ ±20 px in each direction).
- Per-arm; L and R have separate offsets.

## Don't touch

sid=0x80 (`dev_config`) has additional fields that look like they might be
settings but are actually developer/debug knobs — poking at them has
bricked one pair of glasses during early RE (non-terminally, but it took a
power-cycle + re-pair to recover). Stay on sid=0x09 unless you know
exactly what you're doing.
