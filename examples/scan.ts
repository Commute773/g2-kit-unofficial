#!/usr/bin/env bun
// Generic BLE scanner — lists every advertising device nearby.
//
// Not G2-specific. Useful as a sanity check that noble / the BLE stack is
// working before trying to connect to anything. Run with:
//
//     bun examples/scan.ts
//
// Exits after 15 s or on Ctrl-C, whichever comes first, printing a summary.

import noble from "@stoprocent/noble";

const seen = new Map<string, { name: string; rssi: number; services: string[] }>();

console.log("Scanning for BLE devices... (Ctrl+C to stop)\n");

noble.on("discover", (p) => {
  const name = p.advertisement.localName || "(no name)";
  const uuid = p.uuid;
  const rssi = p.rssi;
  const services = (p.advertisement.serviceUuids || []).map((u) => u.toLowerCase());

  if (seen.has(uuid)) return;
  seen.set(uuid, { name, rssi, services });

  console.log(`[NEW] ${name}`);
  console.log(`      UUID: ${uuid}`);
  console.log(`      RSSI: ${rssi} dBm`);
  if (services.length > 0) console.log(`      Services: ${services.join(", ")}`);
  if (p.advertisement.manufacturerData) {
    console.log(`      MfgData: ${p.advertisement.manufacturerData.toString("hex")}`);
  }
  console.log();
});

noble.on("stateChange", async (state) => {
  if (state === "poweredOn") await noble.startScanningAsync([], true);
});

function summary() {
  console.log("\n--- Summary ---");
  console.log(`Found ${seen.size} devices:\n`);
  for (const [uuid, info] of seen) {
    console.log(`  ${info.name} (${uuid}) RSSI=${info.rssi}`);
  }
  process.exit(0);
}

process.on("SIGINT", summary);
setTimeout(summary, 15_000);
