# EvenHub commands (sid=0xe0)

Every render / UI / audio operation is a sid=0xe0 envelope whose payload is a
`EvenHub` protobuf with a top-level `Cmd` enum. The commands we have mapped:

| Cmd | Name | Direction | Purpose |
|---|---|---|---|
| `0` | `CreateStartUpPage` | host → glasses | Create a container. Used for CREATE of list, text, image, and the session-prelude startup page. |
| `3` | `UpdateImageRawData` | host → glasses | Push one fragment of raw 4bpp image pixels into a previously created image container. Forms a streaming pipeline — see `images.md`. |
| `7` | `UpdateContainer` | host → glasses | UPDATE a previously created container's content (swap text lines, swap image tile references, change list items, etc). Also used for REBUILD in multi-object frames — see `containers.md`. |
| `9` | `ShutDown` | host → glasses | Tear down a container (or the whole plugin task, depending on args). |
| `12` | `Heartbeat` | host → glasses | Keep the plugin task alive. The firmware watchdog tears down the plugin task if it hasn't seen traffic for ~10 s. Mirai beats every 5 s; we default to the same. |
| `18` | `AudioCtrCmd` | host → glasses | Enable/disable the mic stream. See `audio.md`. |
| `19` | `AudioCtrRes` | glasses → host | Ack for Cmd=18. Flag=0x01. |

There are more Cmds in the firmware dispatch table (notifications, animations,
widget bindings) that we haven't needed. When you add one, name it here.

## Container type inside Cmd=0 / Cmd=7

Cmd=0 CreateStartUpPage and Cmd=7 UpdateContainer take a `container` message
whose oneof selects the container kind:

```
Container {
  oneof kind {
    ListContainer    list     = 2;
    TextContainer    text     = 3;
    ImageContainer   image    = 4;
    StartUpContainer startup  = 5;  // used for session-prelude CREATE only
  }
  string name = 1;       // ≤14 chars; required
  uint32 seq  = 6;       // per-container sequence for UPDATE diffing
}
```

Field numbers are taken from the wire ordering observed in captures; the proto
files in `~/g2-re/` have the canonical generated definitions.

### ListContainer

```
ListContainer {
  repeated ListItem items = 1;   // one per visible row
  uint32 selected_index   = 2;
  ListStyle style         = 3;
}

ListItem {
  string text            = 1;    // row label
  uint32 tag             = 2;    // host-assigned row id (we echo in tap event)
  bool   enabled         = 3;
}
```

List rows support a `tag` field that comes back in the tap event (sid=0xe0
flag=0x01 Cmd=0) so you can map a tap to a logical row without tracking the
index separately. See `events.md`.

### TextContainer

```
TextContainer {
  repeated TextObject objects = 1;
  TextStyle           style   = 2;
  bool                capture_events = 3;  // default FALSE — must set true for taps!
}

TextObject {
  string text          = 1;
  uint32 color         = 2;   // ARGB8888; only luminance matters on the lens
  Rect   bounds        = 3;   // x/y/w/h in lens pixels
  uint32 font_size_hint = 4;  // firmware ignores this; font is fixed LVGL
}
```

See `text.md` for the tap-capture gotcha and the fixed 50×10 grid.

### ImageContainer

```
ImageContainer {
  repeated ImageObject objects = 1;   // multi-tile REBUILD in one Cmd=7
  ImageStyle           style   = 2;
}

ImageObject {
  string id            = 1;  // tile id, matched by Cmd=3 UpdateImageRawData
  Rect   bounds        = 2;  // where this tile draws on the lens
  uint32 width         = 3;  // pixel width (must match Cmd=3 payload)
  uint32 height        = 4;  // pixel height
}
```

A Cmd=7 UpdateContainer with N `ImageObject`s inside an `ImageContainer` is
the **REBUILD** operation: the firmware tears down the existing tiles and
expects fresh Cmd=3 raw-data pushes for each id before the next frame renders.
See `images.md`.

## Cmd=3 UpdateImageRawData wire shape

```
UpdateImageRawData {
  string container_name = 1;   // name of the ImageContainer
  string object_id      = 2;   // tile id inside that container
  uint32 offset         = 3;   // byte offset into the tile's pixel buffer
  bytes  data           = 4;   // 4bpp packed pixels, up to ~4 KB per fragment
  bool   is_last        = 5;   // true on the final fragment; triggers render
}
```

4 KB is the firmware's soft cap per fragment. Splitting into more-but-smaller
chunks is fine; going larger silently drops the frame.

## Cmd=12 Heartbeat wire shape

```
Heartbeat {
  uint32 magic = 1;
}
```

Send every ~5 s once the first container has been created (heartbeats before
the first CREATE are wasted — the plugin task doesn't exist yet). Use the
`startHeartbeat` helper in `g2-kit/ui` with `shouldBeat: () => firstCreateDone`.
