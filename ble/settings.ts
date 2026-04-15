// G2 device settings helpers (sid=0x09, g2_setting subsystem).
//
// All settings that the Even app exposes ride on one envelope:
//   G2SettingPackage {
//     commandId = DeviceReceiveInfo     (1)  → app→device mutation
//     commandId = DeviceReceiveRequest  (2)  → app→device read OR device push
//     deviceReceiveInfoFromApp = DeviceReceiveInfoFromAPP { ...leaf message... }
//   }
//
// Reads use the request message with `settingInfoType`. The device responds
// with a full snapshot (battery, FW, brightness, head-up angle, etc.) that
// we decode into a `DeviceSettingsSnapshot`.

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { G2SessionLike } from "./session";
import {
  APPRequestSettingType,
  G2SettingPackageSchema,
  g2_settingCommandId,
} from "./gen/g2_setting_pb";

export const SID_UI_SETTING = 0x09;

export interface DeviceSettingsSnapshot {
  battery: number;
  chargingStatus: number;
  leftSoftwareVersion: string;
  rightSoftwareVersion: string;
  autoBrightnessLevel: number;
  autoBrightnessSwitchRestored: number;
  headUpSwitchRestored: number;
  headUpAngleRestored: number;
  wearDetectionSwitchRestored: number;
  silentModeSwitchRestored: number;
  xCoordinateLevelRestored: number;
  yCoordinateLevelRestored: number;
  deviceRunningStatus: number;
  unreadMessageCount: number;
}

function emptySnapshot(): DeviceSettingsSnapshot {
  return {
    battery: 0,
    chargingStatus: 0,
    leftSoftwareVersion: "",
    rightSoftwareVersion: "",
    autoBrightnessLevel: 0,
    autoBrightnessSwitchRestored: 0,
    headUpSwitchRestored: 0,
    headUpAngleRestored: 0,
    wearDetectionSwitchRestored: 0,
    silentModeSwitchRestored: 0,
    xCoordinateLevelRestored: 0,
    yCoordinateLevelRestored: 0,
    deviceRunningStatus: 0,
    unreadMessageCount: 0,
  };
}

// Decode a G2SettingPackage ack payload into a snapshot. Returns null when
// the payload doesn't carry a deviceReceiveRequestFromApp field.
export function decodeSettingsSnapshot(pb: Uint8Array): DeviceSettingsSnapshot | null {
  try {
    const msg = fromBinary(G2SettingPackageSchema, pb);
    const r = msg.deviceReceiveRequestFromApp;
    if (!r) return null;
    return {
      battery: r.battery,
      chargingStatus: r.chargingStatus,
      leftSoftwareVersion: r.leftSoftwareVersion,
      rightSoftwareVersion: r.rightSoftwareVersion,
      autoBrightnessLevel: r.autoBrightnessLevel,
      autoBrightnessSwitchRestored: r.autoBrightnessSwitchRestored,
      headUpSwitchRestored: r.headUpSwitchRestored,
      headUpAngleRestored: r.headUpAngleRestored,
      wearDetectionSwitchRestored: r.wearDetectionSwitchRestored,
      silentModeSwitchRestored: r.silentModeSwitchRestored,
      xCoordinateLevelRestored: r.xCoordinateLevelRestored,
      yCoordinateLevelRestored: r.yCoordinateLevelRestored,
      deviceRunningStatus: r.deviceRunningStatus,
      unreadMessageCount: r.unreadMessageCount,
    };
  } catch {
    return null;
  }
}

// One read. Returns `null` on ack timeout.
export async function querySettings(
  session: G2SessionLike,
  magic: number,
): Promise<DeviceSettingsSnapshot | null> {
  const req = create(G2SettingPackageSchema, {
    commandId: g2_settingCommandId.DeviceReceiveRequest,
    magicRandom: magic,
    deviceReceiveRequestFromApp: {
      settingInfoType: APPRequestSettingType.APP_REQUIRE_BASIC_SETTING,
    },
  });
  const pb = toBinary(G2SettingPackageSchema, req);
  const ack = await session.sendPb(SID_UI_SETTING, pb, magic, { ackTimeoutMs: 4000 });
  if (!ack) return null;
  return decodeSettingsSnapshot(ack.pb) ?? emptySnapshot();
}

// Every leaf mutation goes through `sendDeviceReceive` with one field
// populated. We pass the field via an `init` callback so the caller keeps
// access to the proto's rich nested types.

type G2SettingInit = Parameters<typeof create<typeof G2SettingPackageSchema>>[1];
type DeviceReceiveInit = NonNullable<G2SettingInit>["deviceReceiveInfoFromApp"];

export async function sendDeviceReceive(
  session: G2SessionLike,
  magic: number,
  init: DeviceReceiveInit,
): Promise<boolean> {
  const req = create(G2SettingPackageSchema, {
    commandId: g2_settingCommandId.DeviceReceiveInfo,
    magicRandom: magic,
    deviceReceiveInfoFromApp: init,
  });
  const pb = toBinary(G2SettingPackageSchema, req);
  const ack = await session.sendPb(SID_UI_SETTING, pb, magic, { ackTimeoutMs: 4000 });
  return !!ack;
}

// Thin typed wrappers. Each returns the ack-bool so the UI can refuse to
// update its cached snapshot when the device didn't confirm.

export function setBrightness(
  session: G2SessionLike,
  magic: number,
  v: { autoAdjust?: number; brightnessLevel?: number; leftCalibration?: number; rightCalibration?: number },
) {
  return sendDeviceReceive(session, magic, { deviceReceiveBrightness: v });
}

export function setHeadUp(
  session: G2SessionLike,
  magic: number,
  v: { headUpSwitch?: number; headUpAngle?: number; headUpCalibrationSwitch?: number; headUpCalibration?: number },
) {
  return sendDeviceReceive(session, magic, { deviceReceiveHeadUpSetting: v });
}

export function setWearDetection(session: G2SessionLike, magic: number, wearDetectionSwitch: number) {
  return sendDeviceReceive(session, magic, { deviceReceiveWearDetection: { wearDetectionSwitch } });
}

export function setSilentMode(session: G2SessionLike, magic: number, silentModeSwitch: number) {
  return sendDeviceReceive(session, magic, { deviceReceiveSilentMode: { silentModeSwitch } });
}

export function setDominantHand(session: G2SessionLike, magic: number, dominantHand: number) {
  return sendDeviceReceive(session, magic, { appSendDominantHand: { dominantHand } });
}

export function setXCoordinate(session: G2SessionLike, magic: number, xCoordinateLevel: number) {
  return sendDeviceReceive(session, magic, { deviceReceiveXCoordinate: { xCoordinateLevel } });
}

export function setYCoordinate(session: G2SessionLike, magic: number, yCoordinateLevel: number) {
  return sendDeviceReceive(session, magic, { deviceReceiveYCoordinate: { yCoordinateLevel } });
}

export function setUniverseSetting(
  session: G2SessionLike,
  magic: number,
  v: { unitFormat?: number; distanceUnit?: number; timeFormat?: number; dateFormat?: number; temperatureUnit?: number },
) {
  return sendDeviceReceive(session, magic, { appSendUniverseSetting: v });
}
