#!/usr/bin/env bun
// Stream LC3 mic audio from the glasses for 10 seconds and decode it to PCM.
//
// Demonstrates:
//   - Creating a container to bring the plugin task up (required before
//     AudioCtrCmd enable will take effect)
//   - AudioCapture wrapper over the LC3 stream
//   - G2AudioDecoder: LC3 → 16 kHz mono PCM
//
//     bun examples/mic-stream.ts [outfile.pcm]
//
// If an outfile is given, raw 16-bit mono PCM is written there. Play it
// with:   ffplay -f s16le -ar 16000 -ac 1 outfile.pcm

import {
  G2Session,
  AudioCapture,
  G2AudioDecoder,
  buildCreateStartUpPageContainer,
} from "g2-kit/ble";
import { startHeartbeat } from "g2-kit/ui";
import { createWriteStream } from "node:fs";

const outfile = process.argv[2];
const out = outfile ? createWriteStream(outfile) : null;

let magic = 100;
const nextMagic = () => (magic = magic >= 255 ? 100 : magic + 1);

const session = await G2Session.open();

// Mic streaming requires a live plugin task, which requires at least one
// container. Push a minimal placeholder so the firmware is ready for
// AudioCtrCmd enable.
const create = buildCreateStartUpPageContainer({
  name: "mic-demo",
  items: ["listening..."],
  magic: nextMagic(),
});
if (!(await session.sendPb(0xe0, create.pb, create.magic))) {
  throw new Error("CREATE did not ack — cannot bring up plugin task");
}
const hb = startHeartbeat({ session, nextMagic });

const decoder = new G2AudioDecoder();
const cap = new AudioCapture(session);

let packetCount = 0;
let sampleCount = 0;
cap.onPacket((pkt) => {
  packetCount++;
  // decodePacket returns a VIEW into an internal reusable buffer — copy
  // before enqueuing anywhere that outlives the next call.
  const pcm = decoder.decodePacket(pkt.data);
  sampleCount += pcm.length;
  if (out) {
    const b = Buffer.alloc(pcm.length * 2);
    for (let i = 0; i < pcm.length; i++) b.writeInt16LE(pcm[i]!, i * 2);
    out.write(b);
  }
});

await cap.start();
console.log("streaming for 10 s...");
await new Promise((r) => setTimeout(r, 10_000));
await cap.stop();

console.log(`got ${packetCount} packets, ${sampleCount} samples (${(sampleCount / 16000).toFixed(1)}s)`);
if (out) {
  await new Promise((r) => out.end(r));
  console.log(`wrote ${outfile} — play with: ffplay -f s16le -ar 16000 -ac 1 ${outfile}`);
}

hb.stop();
await session.close();
process.exit(0);
