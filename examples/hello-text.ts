#!/usr/bin/env bun
// Hello, lens — render text and update it every second with a countdown.
//
// Exercises the core render loop:
//   1. CREATE a container (first CREATE must ack)
//   2. Start the heartbeat (gated on firstCreateDone)
//   3. Cmd=7 UPDATE text content repeatedly (cheap, acks normally)
//   4. Tear down cleanly
//
//     bun examples/hello-text.ts
//
// Watch the lens: a 10-second countdown, then the session closes.

import {
  G2Session,
  buildCreateStartUpPageContainer,
  buildUpdateTextContainer,
} from "g2-kit/ble";
import { startHeartbeat } from "g2-kit/ui";

const NAME = "hello";

let magic = 100;
const nextMagic = () => (magic = magic >= 255 ? 100 : magic + 1);

const session = await G2Session.open();

// Step 1: CREATE. The first Cmd=0 on a given name must ack; the library
// waits for that ack via `session.sendPb`. Subsequent CREATEs of the same
// name silently won't ack (see ble/docs/containers.md) — if you rerun this
// example without reconnecting the lens, treat that as fire-and-forget.
const create = buildCreateStartUpPageContainer({
  name: NAME,
  items: ["connecting..."],
  magic: nextMagic(),
});
const createAck = await session.sendPb(0xe0, create.pb, create.magic);
if (!createAck) throw new Error("CREATE did not ack — is another session live?");

// Step 2: heartbeat. Without it, the plugin task dies after ~10 s and every
// subsequent UPDATE goes into the void.
const hb = startHeartbeat({ session, nextMagic });

// Step 3: countdown loop. Each tick is a Cmd=7 RebuildPageContainer with a
// new Content string. captureEvents defaults to false on text — we don't
// need taps for this demo, so leave it off.
for (let i = 10; i >= 0; i--) {
  const update = buildUpdateTextContainer({
    name: NAME,
    text: `hello, lens\n\nclosing in ${i}...`,
    magic: nextMagic(),
  });
  const ack = await session.sendPb(0xe0, update.pb, update.magic);
  console.log(`tick ${i} ${ack ? "✓" : "✗"}`);
  if (i > 0) await new Promise((r) => setTimeout(r, 1000));
}

// Step 4: teardown.
hb.stop();
await session.close();
process.exit(0);
