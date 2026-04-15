// EvenHub message builders backed by protobuf-es generated types.
//
// The generated schema (lib/gen/EvenHub_pb.ts) comes from
// ~/g2-re/proto/EvenHub.proto, which was reconstructed from the
// Blutter-decompiled com.even.sg Flutter AOT. Every field name here matches
// the firmware's internal names.
//
// Command codes on sid=0xe0 (EvenHub main subsystem):
//   Cmd=0  APP_REQUEST_CREATE_STARTUP_PAGE_PACKET  (launcher list)
//   Cmd=3  APP_UPDATE_IMAGE_RAW_DATA_PACKET        (image pixel stream)
//   Cmd=5  APP_UPDATE_TEXT_DATA_PACKET             (TextContainerUpgrade)
//   Cmd=7  APP_REQUEST_REBUILD_PAGE_PACKET         (update a container)
//   Cmd=12 APP_REQUEST_HEARTBEAT_PACKET

import { create, toBinary } from "@bufbuild/protobuf";
import {
  evenhub_main_msg_ctxSchema,
  EvenHub_Cmd_List,
} from "./gen/EvenHub_pb";

function assertNameLen(name: string) {
  if (name.length > 14) {
    throw new Error(`container name "${name}" > 14 chars — firmware will reject`);
  }
}

// ---------- Cmd=0 CreateStartUpPageContainer ----------

export interface StartUpPageOptions {
  x?: number;                // XPosition, default 0
  y?: number;                // YPosition, default 0
  width?: number;            // Width, default 280
  height?: number;           // Height, default 130
  name: string;              // ContainerName, ≤14 chars
  items: string[];           // ItemName list (utf-8, emoji OK)
  widgetId?: number;         // CreateStartUpPageContainer.widgetId, default 10000
  containerId?: number;      // ContainerID, default 1
  selectionBorder?: boolean; // IsItemSelectBorderEn, default true
  captureEvents?: boolean;   // IsEventCapture, default true
  magic?: number;            // MagicRandom ack-matching key, default 201
}

export function buildCreateStartUpPageContainer(opts: StartUpPageOptions): {
  pb: Uint8Array;
  magic: number;
} {
  assertNameLen(opts.name);
  const magic = opts.magic ?? 201;
  const msg = create(evenhub_main_msg_ctxSchema, {
    Cmd: EvenHub_Cmd_List.APP_REQUEST_CREATE_STARTUP_PAGE_PACKET,
    MagicRandom: magic,
    CreateMessage: {
      ContainerTotalNum: 1,
      widgetId: opts.widgetId ?? 10000,
      ListObject: [{
        XPosition: opts.x ?? 0,
        YPosition: opts.y ?? 0,
        Width: opts.width ?? 280,
        Height: opts.height ?? 130,
        ContainerID: opts.containerId ?? 1,
        ContainerName: opts.name,
        IsEventCapture: (opts.captureEvents ?? true) ? 1 : 0,
        ItemContainer: {
          ItemCount: opts.items.length,
          IsItemSelectBorderEn: (opts.selectionBorder ?? true) ? 1 : 0,
          ItemName: opts.items,
        },
      }],
    },
  });
  return { pb: toBinary(evenhub_main_msg_ctxSchema, msg), magic };
}

// ---------- Cmd=7 RebuildPageContainer (update text) ----------

export interface TextContainerOptions {
  x?: number;          // default 0
  y?: number;          // default 0
  width?: number;      // default 576 (50×10 LVGL grid)
  height?: number;     // default 288
  name: string;
  text: string;        // pre-formatted, content cap ~1000 bytes
  containerId?: number;// default 1
  captureEvents?: boolean; // default false for text — we don't tap text areas
  magic?: number;
}

export function buildUpdateTextContainer(opts: TextContainerOptions): {
  pb: Uint8Array;
  magic: number;
} {
  assertNameLen(opts.name);
  const magic = opts.magic ?? 202;
  const msg = create(evenhub_main_msg_ctxSchema, {
    Cmd: EvenHub_Cmd_List.APP_REQUEST_REBUILD_PAGE_PACKET,
    MagicRandom: magic,
    RebuildContainer: {
      ContainerTotalNum: 1,
      TextObject: [{
        XPosition: opts.x ?? 0,
        YPosition: opts.y ?? 0,
        Width: opts.width ?? 576,
        Height: opts.height ?? 288,
        ContainerID: opts.containerId ?? 1,
        ContainerName: opts.name,
        IsEventCapture: opts.captureEvents ? 1 : 0,
        Content: opts.text,
      }],
    },
  });
  return { pb: toBinary(evenhub_main_msg_ctxSchema, msg), magic };
}

// ---------- Cmd=7 RebuildPageContainer (update list) ----------

export interface UpdateListOptions {
  x?: number;          // default 0
  y?: number;          // default 0
  width?: number;      // default 576
  height?: number;     // default 288
  name: string;
  items: string[];
  containerId?: number;
  selectionBorder?: boolean;
  captureEvents?: boolean;
  magic?: number;
}

export function buildUpdateListContainer(opts: UpdateListOptions): {
  pb: Uint8Array;
  magic: number;
} {
  assertNameLen(opts.name);
  const magic = opts.magic ?? 203;
  const msg = create(evenhub_main_msg_ctxSchema, {
    Cmd: EvenHub_Cmd_List.APP_REQUEST_REBUILD_PAGE_PACKET,
    MagicRandom: magic,
    RebuildContainer: {
      ContainerTotalNum: 1,
      ListObject: [{
        XPosition: opts.x ?? 0,
        YPosition: opts.y ?? 0,
        Width: opts.width ?? 576,
        Height: opts.height ?? 288,
        ContainerID: opts.containerId ?? 1,
        ContainerName: opts.name,
        IsEventCapture: (opts.captureEvents ?? true) ? 1 : 0,
        ItemContainer: {
          ItemCount: opts.items.length,
          IsItemSelectBorderEn: (opts.selectionBorder ?? true) ? 1 : 0,
          ItemName: opts.items,
        },
      }],
    },
  });
  return { pb: toBinary(evenhub_main_msg_ctxSchema, msg), magic };
}

// ---------- Cmd=12 Heartbeat ----------

export interface HeartbeatOptions {
  cnt?: number;  // default 0; firmware ignores the value, the packet itself is the heartbeat
  magic?: number;
}

/**
 * Mirai sends a Cmd=12 heartbeat on sid=0xe0 every ~5 seconds after
 * createStartUpPageContainer succeeds. Without heartbeats the firmware
 * assumes the app has gone away and silently drops subsequent REBUILD
 * and CREATE commands (they produce no ack). `_startHeartbeat()` in the
 * decompiled EvenHubAppService is the source of truth.
 */
export function buildHeartbeat(opts: HeartbeatOptions = {}): {
  pb: Uint8Array;
  magic: number;
} {
  const magic = opts.magic ?? 205;
  const msg = create(evenhub_main_msg_ctxSchema, {
    Cmd: EvenHub_Cmd_List.APP_REQUEST_HEARTBEAT_PACKET,
    MagicRandom: magic,
    HeartPacketCmd: {
      Cnt: opts.cnt ?? 0,
    },
  });
  return { pb: toBinary(evenhub_main_msg_ctxSchema, msg), magic };
}

// ---------- Cmd=7 RebuildPageContainer (create/update image containers) ----------

export interface ImageContainerSpec {
  x: number;
  y: number;
  width: number;
  height: number;
  containerId: number;
  name: string;
}

/**
 * Build a Cmd=7 REBUILD that declares one-or-more image containers in a
 * single frame. The G2 firmware accepts a repeated `ImageObject` array
 * exactly like `TextObject`, so a 576×288 full-lens image can be laid out
 * as a 2×2 grid of 288×144 tiles in one round trip.
 *
 * After this call acks, push the pixel data for each tile via
 * `buildImageRawData` (one call per app-level fragment of ~4 KB).
 */
export function buildImageContainers(opts: {
  containers: ImageContainerSpec[];
  magic?: number;
}): { pb: Uint8Array; magic: number } {
  for (const c of opts.containers) assertNameLen(c.name);
  const magic = opts.magic ?? 210;
  const msg = create(evenhub_main_msg_ctxSchema, {
    Cmd: EvenHub_Cmd_List.APP_REQUEST_REBUILD_PAGE_PACKET,
    MagicRandom: magic,
    RebuildContainer: {
      ContainerTotalNum: opts.containers.length,
      ImageObject: opts.containers.map((c) => ({
        XPosition: c.x,
        YPosition: c.y,
        Width: c.width,
        Height: c.height,
        ContainerID: c.containerId,
        ContainerName: c.name,
      })),
    },
  });
  return { pb: toBinary(evenhub_main_msg_ctxSchema, msg), magic };
}

// ---------- Cmd=3 UpdateImageRawData (one pixel fragment) ----------

/**
 * Build a single Cmd=3 `APP_UPDATE_IMAGE_RAW_DATA_PACKET` message. The
 * raw 4-bpp BMP bytes for a container are split by the caller into
 * app-level fragments (firmware-observed cap: 4096 B per fragment;
 * ≥6144 B rejects with error code 7) and one call is made per fragment.
 *
 * All fragments share the same ContainerID/Name/MapSessionId/MapTotalSize;
 * only MapFragmentIndex, MapFragmentPacketSize, and MapRawData change.
 * MagicRandom is used by the caller as the ack key for this specific
 * fragment, so each fragment needs a unique magic.
 *
 * Throughput ceiling (measured 2026-04-14 on a 288×144 4bpp 20854 B BMP):
 * ~2.4 s per image in serial, bottlenecked by ~400–500 ms firmware ack
 * latency per 4 KB fragment — not BLE wire time.
 */
export function buildImageRawData(opts: {
  containerId: number;
  containerName: string;
  mapSessionId: number;
  mapTotalSize: number;
  mapFragmentIndex: number;
  mapRawData: Uint8Array;
  compressMode?: number; // default 0 (uncompressed)
  magic: number;         // caller chooses — must be unique per fragment
}): { pb: Uint8Array; magic: number } {
  assertNameLen(opts.containerName);
  const msg = create(evenhub_main_msg_ctxSchema, {
    Cmd: EvenHub_Cmd_List.APP_UPDATE_IMAGE_RAW_DATA_PACKET,
    MagicRandom: opts.magic,
    ImgRawMsg: {
      ContainerID: opts.containerId,
      ContainerName: opts.containerName,
      MapSessionId: opts.mapSessionId,
      MapTotalSize: opts.mapTotalSize,
      CompressMode: opts.compressMode ?? 0,
      MapFragmentIndex: opts.mapFragmentIndex,
      MapFragmentPacketSize: opts.mapRawData.length,
      MapRawData: opts.mapRawData,
    },
  });
  return { pb: toBinary(evenhub_main_msg_ctxSchema, msg), magic: opts.magic };
}

// ---------- Cmd=9 ShutDown (tear down current container) ----------

export interface ShutDownOptions {
  exitMode?: number; // default 0
  magic?: number;    // default 204
}

/**
 * Dismiss whatever container is currently foregrounded on the glasses.
 * No container name — the firmware only tracks one active StartUpPage
 * at a time, so this always targets that one. Use this before a fresh
 * `buildCreateStartUpPageContainer` when you need to swap shapes
 * (list → text) or refresh a same-named container, since CreateStartUpPage
 * is silently rejected if a container with the same name is still live.
 */
export function buildShutDown(opts: ShutDownOptions = {}): {
  pb: Uint8Array;
  magic: number;
} {
  const magic = opts.magic ?? 204;
  const msg = create(evenhub_main_msg_ctxSchema, {
    Cmd: EvenHub_Cmd_List.APP_REQUEST_SHUTDOWN_PAGE_PACKET,
    MagicRandom: magic,
    ShutDownCmd: {
      exitMode: opts.exitMode ?? 0,
    },
  });
  return { pb: toBinary(evenhub_main_msg_ctxSchema, msg), magic };
}

// ---------- Known transport prelude ----------

// f5872 from the capture — sid=01 Cmd=2 app-launch. Must be sent once per
// fresh BLE session before any EvenHub Cmd will be accepted.
export const PRELUDE_F5872 = new Uint8Array([
  0xaa, 0x21, 0x92, 0x13, 0x01, 0x01, 0x01, 0x20, 0x08, 0x02, 0x10, 0x9c,
  0x01, 0x22, 0x0a, 0x1a, 0x08, 0x12, 0x06, 0x12, 0x04, 0x08, 0x00, 0x10,
  0x00, 0xa1, 0x42,
]);
export const PRELUDE_F5872_SID = 0x01;
export const PRELUDE_F5872_SEQ = 156; // f2 of the inner pb — used as ack key
