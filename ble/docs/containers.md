# Containers — lifecycle, naming, shape transitions

Everything on the G2 lens is a "container": list, text, image, startup page.
The firmware tracks them by **name** inside the active plugin task, and the
rules around creating, updating, and swapping shapes are non-obvious enough
that getting them wrong is the usual reason a fresh integration "doesn't
render anything".

## Name rules

- Name is a string field on the container protobuf. Required.
- **Hard cap: 14 characters.** Longer names are silently rejected — no error,
  no render.
- Any otherwise-printable ASCII works. Case matters.
- Names are the *identity* of the container. The firmware keys its internal
  state off of `name`, so "the list container" and "my list" are two separate
  containers.

## CREATE — Cmd=0 CreateStartUpPage

The first Cmd=0 for a given `name` creates the container. You get an ack back
with your echoed `magic`. So far so boring.

**Subsequent Cmd=0 writes for the same `name` do not ack.**

This is the first major gotcha. If you send another CREATE for the same name
because you want to reset the container, the firmware accepts it internally
but does not emit an ack frame. If your code blocks waiting for that ack, you
will hang forever.

Workaround: track which names you've already created (`listCreated`,
`textCreated`, `imageCreated` flags in the bridge), and after the first CREATE
use Cmd=7 UpdateContainer for all subsequent mutations.

If you actually need to fully recreate a container (e.g. the firmware torn it
down after a shutdown), the trick is to use a *different* name for the
recreate. See "two-names shape transitions" below.

## UPDATE — Cmd=7 UpdateContainer

Replaces the contents of a previously-created container with the same name.
Cheap, acks normally, and is the common path for "redraw my list with
different items" or "swap the lines of this text container".

UPDATE **cannot change the container's shape.** If you originally created it
as a ListContainer, you can only UPDATE it with new ListContainers; if you
try to UPDATE it with a TextContainer, the firmware drops the frame.

## Shape transitions — two names

When the UI actually needs to change shape (e.g. list → text), the pattern is:

1. Create a text container with a **different name** (`"text-a"`).
2. Once it is on screen, Cmd=9 ShutDown the old list container (`"list-a"`).

The blank-lens trick (below) is often used in between so the user doesn't see
a flash of the old container.

In this library's bridge, text and list each use two names (`"text-a"` and
`"text-b"`) and flip-flop between them on every shape transition. This
guarantees every transition is always a fresh CREATE, never an UPDATE-that-
changes-shape.

## REBUILD — multi-object Cmd=7

A Cmd=7 UpdateContainer whose inner container has **multiple TextObjects or
multiple ImageObjects** atomically tears down the old object list and rebuilds
with the new one. For images, this invalidates the tile buffers — you have to
re-push Cmd=3 UpdateImageRawData for every tile id before the frame will
render.

This is the **REBUILD** operation, and the image streamer has special handling
for it:

1. Detect new tile layout (number of tiles, sizes, or ids changed).
2. Send Cmd=7 with the full new ImageObject list.
3. Re-push every tile via the Cmd=3 streaming pipeline.
4. After the REBUILD completes, notify the consumer via the
   `onRebuildSuccess` callback so they can invalidate any entangled
   containers. In practice this means the bridge clears `listCreated` and
   `textCreated` because a REBUILD of the image container can silently blow
   away sibling containers in the plugin task.

## Cmd=9 ShutDown

```
ShutDown {
  string name = 1;   // container name to destroy; empty = whole plugin task
}
```

Destroys the container and frees its backing memory. An empty `name` tears
down the whole plugin task, which is a heavier reset — the next render will
need to re-run the session prelude.

## Soft sleep — 1×1 blank-lens trick

The cheapest way to "turn off" the lens without actually sleeping is to push a
**1×1 transparent image** as a single-tile ImageContainer. This keeps the
plugin task and event pipeline alive (so container taps still fire), but the
lens is functionally dark. Waking back up is a Cmd=3 push of real pixel data
— no CREATE, no shape transition, just a content update.

This is the pattern the cmux bridge uses for sleep/wake. Using `Cmd=9` to
tear down the container would work but kills the event pipeline, which is
expensive to bring back.

## TTL

Container state has no TTL — it persists as long as the plugin task does,
which persists as long as heartbeats keep coming. Once heartbeats stop for
~10 s the firmware watchdog tears the whole plugin task down, all containers
go with it, and the next frame needs to restart from the session prelude.
