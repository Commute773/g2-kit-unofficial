#!/usr/bin/env bun
// Minimal scan + connect + prelude + read battery + disconnect.
//
// This is the "does my setup actually work end-to-end?" example. Everything
// interesting about the connection sequence is hidden inside G2Session.open():
// BLE scan, connect both arms, discover characteristics, subscribe to
// notify channels, send the mandatory session prelude. If any of that is
// broken this is where you'll notice.
//
//     bun examples/connect.ts
//
// Expected output on a healthy session:
//     [hh:mm:ss.mmm] g2-session: scanning
//     [hh:mm:ss.mmm] g2-session: connected, settling 800ms
//     [hh:mm:ss.mmm] g2-session: prelude f5872
//     battery: L=87 R=89   charging=0
//     firmware: L=1.8.4 R=1.8.4
//     ok, closing

import { G2Session, querySettings } from "g2-kit/ble";

const session = await G2Session.open();

const settings = await querySettings(session, 100);
if (!settings) {
  console.error("settings query failed — ack timeout");
} else {
  // `battery` is a single uint8 = min(L, R) on this firmware. Individual
  // arms aren't exposed in the basic-setting payload; for per-arm battery
  // you'd need a deeper dive into sid=0x80 dev_config.
  console.log(`battery: ${settings.battery}%   charging=${settings.chargingStatus}`);
  console.log(`firmware: L=${settings.leftSoftwareVersion} R=${settings.rightSoftwareVersion}`);
  console.log(`wear detection: ${settings.wearDetectionSwitchRestored}`);
  console.log(`silent mode: ${settings.silentModeSwitchRestored}`);
}

console.log("ok, closing");
await session.close();
process.exit(0);
