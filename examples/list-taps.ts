#!/usr/bin/env bun
// Interactive list — render a menu, receive tap events, react.
//
// Demonstrates:
//   - CREATE + REBUILD of a ListContainer
//   - session.onEvent() tap subscription
//   - Mapping a tap back to a menu row
//   - Clean teardown
//
//     bun examples/list-taps.ts
//
// Tap any row on the lens; the tap is printed to the console. Tap "exit" to
// close. (Or Ctrl-C in the terminal.)

import {
  G2Session,
  buildCreateStartUpPageContainer,
  buildUpdateListContainer,
} from "g2-kit/ble";
import { startHeartbeat } from "g2-kit/ui";

const NAME = "demo-menu";
const ITEMS = ["apple", "banana", "carrot", "daikon", "exit"];

let magic = 100;
const nextMagic = () => (magic = magic >= 255 ? 100 : magic + 1);

const session = await G2Session.open();

const create = buildCreateStartUpPageContainer({
  name: NAME,
  items: ITEMS,
  magic: nextMagic(),
});
if (!(await session.sendPb(0xe0, create.pb, create.magic))) {
  throw new Error("CREATE did not ack");
}

const hb = startHeartbeat({ session, nextMagic });

// REBUILD to apply full-lens geometry (the default CREATE uses 280×130 so
// that the firmware accepts it — follow up with a REBUILD to resize).
const rebuild = buildUpdateListContainer({
  name: NAME,
  items: ITEMS,
  width: 576,
  height: 288,
  magic: nextMagic(),
});
await session.sendPb(0xe0, rebuild.pb, rebuild.magic);

console.log(`menu up — ${ITEMS.length} items. Tap on the lens.`);

// Subscribe to async events. `onEvent` fires with a decoded union. List
// taps arrive as `kind === "list-click"` with `itemIndex` naming the row
// that was tapped. See ble/events.ts for the full event union (text
// clicks, sys events, state-change, etc).
const off = session.onEvent((ev) => {
  if (ev.kind !== "list-click") return;
  if (ev.containerName !== NAME) return;
  const label = ITEMS[ev.itemIndex] ?? "?";
  console.log(`tap: row ${ev.itemIndex} = "${label}"`);
  if (label === "exit") void shutdown();
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  off();
  hb.stop();
  await session.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);

// Keep the process alive until a tap or SIGINT triggers shutdown.
await new Promise(() => {});
