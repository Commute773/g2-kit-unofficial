#!/usr/bin/env bun
// Hello, lens over DroidBridge.
//
// Usage:
//   DROIDBRIDGE_URL=http://100.82.6.119:8765 \
//   DROIDBRIDGE_TOKEN=your-token \
//   bun examples/droidbridge-hello-text.ts
//
// Optional if you want to avoid scanning entirely:
//   DROIDBRIDGE_LEFT_ADDRESS=EC:D7:82:69:3C:CB \
//   DROIDBRIDGE_RIGHT_ADDRESS=D0:7A:47:82:09:67 \
//   bun examples/droidbridge-hello-text.ts
//
// Notes:
//   - The phone must be running DroidBridge and reachable from this machine.
//   - The glasses must be awake and not actively held by another BLE session.
//   - If the official app is currently talking to the glasses, close or force-stop
//     it before running this demo.

import {
  DroidBridgeSession,
  buildCreateStartUpPageContainer,
  buildUpdateTextContainer,
} from "g2-kit/ble";
import { startHeartbeat } from "g2-kit/ui";

const baseUrl = process.env.DROIDBRIDGE_URL?.trim();
const bearerToken = process.env.DROIDBRIDGE_TOKEN?.trim();
const leftAddress = process.env.DROIDBRIDGE_LEFT_ADDRESS?.trim();
const rightAddress = process.env.DROIDBRIDGE_RIGHT_ADDRESS?.trim();

if (!baseUrl) {
  throw new Error("Set DROIDBRIDGE_URL, for example http://100.82.6.119:8765");
}

const containerName = `db${Date.now().toString().slice(-6)}`;

let magic = 100;
const nextMagic = () => (magic = magic >= 255 ? 100 : magic + 1);

const session = await DroidBridgeSession.open({
  baseUrl,
  bearerToken,
  leftAddress,
  rightAddress,
});

const hb = startHeartbeat({ session, nextMagic });

try {
  const create = buildCreateStartUpPageContainer({
    name: containerName,
    items: ["DroidBridge"],
    magic: nextMagic(),
  });
  const createAck = await session.sendPb(0xe0, create.pb, create.magic);
  if (!createAck) {
    throw new Error("CREATE did not ack - the glasses may still be connected to the official app");
  }

  for (let i = 10; i >= 0; i--) {
    const update = buildUpdateTextContainer({
      name: containerName,
      text: `hello, lens\n\ndroidbridge ok\n\nclosing in ${i}...`,
      magic: nextMagic(),
    });
    const ack = await session.sendPb(0xe0, update.pb, update.magic);
    console.log(`tick ${i} ${ack ? "✓" : "✗"}`);
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} finally {
  hb.stop();
  await session.close();
}
