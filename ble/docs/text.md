# Text containers

TextContainer is how you put characters on the lens without rendering them
yourself into a bitmap. The firmware owns the font, layout, and line-
wrapping; you hand it strings and bounds rects.

## The grid

- **Fixed LVGL proportional font.** There is no font-size API, no font-family
  API, no weight/italic — whatever shipped in the firmware is what you get.
- **Effective grid: 50 columns × 10 rows** at the default font on a full-lens
  TextContainer. This is empirical — the font is proportional, so "column"
  here means "about the width of an average glyph". Narrow letters pack
  tighter; `W`s and `M`s eat more space.
- Use 50×10 as a planning budget: if you fit a line into 50 columns of
  Latin-1 text, it will generally not wrap. Wider layouts wrap automatically
  with an on-screen scroll bar.

`reference_g2_display_dimensions.md` in memory has the original measurements.
This is the only reference for grid size; the firmware does not expose it.

## Wire layout

```
TextContainer {
  repeated TextObject objects = 1;
  TextStyle           style   = 2;
  bool                capture_events = 3;
}

TextObject {
  string text           = 1;   // the string to render; \n allowed
  uint32 color          = 2;   // ARGB8888; luminance is all that matters
  Rect   bounds         = 3;   // x, y, w, h in lens pixels
  uint32 font_size_hint = 4;   // ignored by firmware
}
```

Multiple TextObjects in one TextContainer renders them all at once, each in
its own bounds. Useful for a header + body layout, or for stacking short
lines without spacing calculations.

## Auto-wrap and scroll

If a `text` string is longer than its bounds can hold, the firmware:

1. Wraps at word boundaries (space / punctuation) where possible.
2. Draws a subtle right-side scroll bar.
3. Does **not** scroll automatically — the scroll bar shows there's more
   content, but the user never sees it unless they scroll via…

…nothing. There is no scroll gesture built into the firmware's text
container. If you need scrolling text, you have to page it yourself on the
host (see the pager in `g2-kit/ui`).

## Content cap

Roughly **~1000 bytes of text** per TextContainer before things start
misbehaving. Hard to say exactly where the limit is — the firmware's error
mode is to render a truncated/empty container, not to reject the write.

If you need more, split into multiple TextContainers (different names) and
manage their lifecycle yourself, or page via the pager utility.

## `capture_events` default-off gotcha

**TextContainer defaults `capture_events` to `false`.** If you don't set it,
tap events on the text area do not fire, and you will think your event
subscription is broken.

```ts
text: { capture_events: true, ... }
```

ListContainer and ImageContainer don't have this problem — they capture by
default.

## Taps route through sys-event CLICK_EVENT

Even once `capture_events: true` is set, **text container taps do NOT come
back as a normal container-press event** (sid=0xe0 flag=0x01 Cmd=0 with the
container name, like list/image do). Instead, they route through a
**system-event CLICK_EVENT** on the sys-event channel.

The sys-event frame has:

- `sid=0xe0`, `flag=0x01`
- Different `Cmd` code (system event dispatch, not container-press)
- A payload identifying "click" but NOT naming the container

This means: if you have multiple text containers on screen at once, you
cannot tell which one was tapped. The click event is "the user tapped
somewhere in the text area" — the disambiguation has to be done host-side.

In practice the bridge works around this by only having one text container
visible at a time (via the two-names shape transition), so every click is
unambiguously for "the current text container".

`project_g2_text_container_taps.md` in memory has the full trace.

## Pager utility

The pager in `g2-kit/ui/pager.ts` exists because of the scroll limitation
and the 50×10 grid: you give it a list of items and a page size and it
produces per-page TextContainer content plus nav rows (`▲ Prev page` /
`▼ Next page`) that can be mapped to list clicks. See `pager.ts` for the API.
