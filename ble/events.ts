// Decoders for the async event channel on sid=0xe0 flag=0x01.
//
// Backed by the protobuf-es generated `evenhub_main_msg_ctx` schema.
// Every field name here matches the firmware's internal names.

import { fromBinary } from "@bufbuild/protobuf";
import {
  evenhub_main_msg_ctxSchema,
  EvenHub_Cmd_List,
  OsEventTypeList,
  EventSourceType,
} from "./gen/EvenHub_pb";

export type DecodedEvent =
  | ListClickEvent
  | TextClickEvent
  | SysEvent
  | PrivateEvent
  | StateChangeEvent
  | UnknownEvent;

export interface ListClickEvent {
  kind: "list-click";
  containerName: string;
  itemIndex: number;
  itemName: string;      // empty string if firmware didn't populate it
  eventType: OsEventTypeList;
}

export interface TextClickEvent {
  kind: "text-click";
  containerName: string;
  eventType: OsEventTypeList;
}

export interface SysEvent {
  kind: "sys-event";
  eventType: OsEventTypeList;
  eventSource: EventSourceType;  // 2 = TOUCH_EVENT_FROM_RING, 1/3 = glasses R/L, 0 = unknown
  systemExitReasonCode: number;
}

// CommonDevicePrivateEvent — sid=0xe0 Cmd=11 OS_PRIVATE_EVENT_PACKET.
export interface PrivateEvent {
  kind: "private-event";
  containerName: string;
  containerId: number;
  eventId: number;
  eventData: number;
}

// sid=0x0d state-change is a DIFFERENT subsystem that isn't covered by the
// EvenHub proto. We still decode it minimally by hand — it's a "something
// changed on subsystem X" ping.
export interface StateChangeEvent {
  kind: "state-change";
  sid: number;
  eventCode?: number;
}

export interface UnknownEvent {
  kind: "unknown";
  sid: number;
  flag: number;
  pbHex: string;
}

function decodeStateChange(pb: Uint8Array): StateChangeEvent | null {
  // Shape: f1=1, f3=bytes{f1=<sid>, [f2=<eventCode>]}
  try {
    // Tiny hand parse — reusing protobuf-es here would require a separate
    // proto schema we don't have.
    let i = 0;
    let innerSid = 0;
    let eventCode: number | undefined;
    while (i < pb.length) {
      const tag = pb[i++]!;
      const field = tag >> 3;
      const wire = tag & 7;
      if (wire === 0) {
        // varint — skip
        while (i < pb.length && (pb[i++]! & 0x80) !== 0) {}
      } else if (wire === 2) {
        // length-delimited
        let len = 0, s = 0;
        while (i < pb.length) {
          const c = pb[i++]!;
          len |= (c & 0x7f) << s;
          if ((c & 0x80) === 0) break;
          s += 7;
        }
        if (field === 3) {
          // inner { f1=<sid>, [f2=<eventCode>] }
          const inner = pb.subarray(i, i + len);
          let j = 0;
          while (j < inner.length) {
            const t2 = inner[j++]!;
            const f2 = t2 >> 3;
            const w2 = t2 & 7;
            if (w2 !== 0) break;
            let v = 0, s2 = 0;
            while (j < inner.length) {
              const c = inner[j++]!;
              v |= (c & 0x7f) << s2;
              if ((c & 0x80) === 0) break;
              s2 += 7;
            }
            if (f2 === 1) innerSid = v;
            else if (f2 === 2) eventCode = v;
          }
        }
        i += len;
      } else {
        return null;
      }
    }
    return { kind: "state-change", sid: innerSid, eventCode };
  } catch {
    return null;
  }
}

// Decode the async-event body from a parsed frame's pb payload.
export function decodeAsyncEvent(sid: number, flag: number, pb: Uint8Array): DecodedEvent {
  if (flag !== 0x01 && flag !== 0x06) {
    return { kind: "unknown", sid, flag, pbHex: Buffer.from(pb).toString("hex") };
  }

  if (sid === 0x0d) {
    const st = decodeStateChange(pb);
    if (st) return st;
  }

  if (sid === 0xe0) {
    // Try with and without trailing 2 bytes — parseFrame may have included
    // the CRC from a last-fragment frame.
    const candidates = [pb, pb.subarray(0, Math.max(0, pb.length - 2))];
    for (const buf of candidates) {
      try {
        const msg = fromBinary(evenhub_main_msg_ctxSchema, buf);

        if (msg.Cmd === EvenHub_Cmd_List.OS_NOITY_EVENT_TO_APP_PACKET && msg.DevEvent) {
          const d = msg.DevEvent;
          if (d.ListEvent) {
            return {
              kind: "list-click",
              containerName: d.ListEvent.ContainerName,
              itemIndex: d.ListEvent.CurrentSelectItemIndex,
              itemName: d.ListEvent.CurrentSelectItemName,
              eventType: d.ListEvent.EventType,
            };
          }
          if (d.TextEvent) {
            return {
              kind: "text-click",
              containerName: d.TextEvent.ContainerName,
              eventType: d.TextEvent.EventType,
            };
          }
          if (d.SysEvent) {
            return {
              kind: "sys-event",
              eventType: d.SysEvent.EventType,
              eventSource: d.SysEvent.EventSource,
              systemExitReasonCode: d.SysEvent.systemExitReasonCode,
            };
          }
        }

        if (msg.Cmd === EvenHub_Cmd_List.OS_PRIVATE_EVENT_PACKET && msg.DevPrivateEvent) {
          return {
            kind: "private-event",
            containerName: msg.DevPrivateEvent.ContainerName,
            containerId: msg.DevPrivateEvent.ContainerID,
            eventId: msg.DevPrivateEvent.eventId,
            eventData: msg.DevPrivateEvent.eventData,
          };
        }

        break;
      } catch {
        // try next candidate
      }
    }
  }

  return { kind: "unknown", sid, flag, pbHex: Buffer.from(pb).toString("hex") };
}
