// Barrel export for the G2 / EvenHub Bluetooth library.
//
// For protocol documentation (envelope framing, sids, EvenHub commands,
// container lifecycle, image pipeline, text quirks, audio, events, gotchas),
// see `./docs/README.md`.

export * from "./crc";
export * from "./envelope";
export * from "./messages";
export * from "./events";
export * from "./ble";
export * from "./session";
export * from "./droidbridge-session";
export * from "./settings";
export * from "./audio";
export * from "./lc3-decoder";
export * from "./image";
export * as r1 from "./ring";
// Re-export commonly used generated enums so consumers don't need to reach
// into lib/gen themselves.
export { OsEventTypeList, EventSourceType, EvenHub_Cmd_List } from "./gen/EvenHub_pb";
