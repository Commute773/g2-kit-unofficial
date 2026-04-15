#!/usr/bin/env bun
// Scan for G2 arms specifically and report what we see.
//
// This is the "can my laptop see the glasses right now?" diagnostic. It uses
// the same `NAME_RE` the library uses internally, so if this prints both L
// and R arms, `G2Session.open()` should succeed. If it doesn't, start here.
//
//     bun examples/find-glasses.ts
//
// Exits after 15 s or once both arms have been seen, whichever comes first.

import noble from "@stoprocent/noble";
import { NAME_RE } from "g2-kit/ble";

type Seen = { name: string; rssi: number; uuid: string };
const seen = new Map<"L" | "R", Seen>();

console.log("Looking for G2 arms... (Ctrl+C to stop)\n");

noble.on("discover", (p) => {
  const m = NAME_RE.exec(p.advertisement.localName || "");
  if (!m) return;
  const side = m[2]!.toUpperCase() as "L" | "R";
  if (seen.has(side)) return;
  seen.set(side, {
    name: p.advertisement.localName || "",
    rssi: p.rssi,
    uuid: p.uuid,
  });
  console.log(`[${side}] ${p.advertisement.localName}`);
  console.log(`    uuid=${p.uuid}  rssi=${p.rssi} dBm`);
  if (seen.size === 2) finish();
});

noble.on("stateChange", async (state) => {
  if (state === "poweredOn") await noble.startScanningAsync([], true);
});

function finish() {
  console.log("\n--- Summary ---");
  if (seen.size === 0) {
    console.log("No G2 arms discovered. Check that the glasses are on and in range.");
  } else {
    for (const [side, s] of seen) console.log(`  ${side}: ${s.name} rssi=${s.rssi}`);
    if (seen.size === 1) console.log("Only one arm — G2Session.open() will hang until the other shows up.");
    else console.log("Both arms visible — G2Session.open() should succeed.");
  }
  process.exit(0);
}

process.on("SIGINT", finish);
setTimeout(finish, 15_000);
