// CFW capability detection.
//
// Our custom firmware advertises itself by appending one extra protobuf field
// (field 100, a string) to the sid=0x09 device-settings READ response
// (G2SettingPackage). Stock firmware never sends it. The string is:
//
//   "EVENCFW/<ver> <space-separated feature tokens>"
//   e.g. "EVENCFW/1 img576 imgz xordelta stereo"
//
// Field 100 is far above the stock message's fields (1..19), so stock decoders
// skip it as an unknown field. We read it with a tiny top-level field-100 scan
// over the raw G2SettingPackage bytes, so detection does NOT depend on the
// generated schema carrying the field. Absence of the field => stock firmware.
//
// Feature tokens currently emitted by the CFW:
//   img576    576x288 image containers (stock caps at 288x144)
//   imgz      zlib (DEFLATE) compressed image payloads
//   xordelta  8bpp full-frame + XOR-delta display modes (load_image_z 2/3)
//   stereo    per-lens stereo image pairs (load_image_z mode 4)

export const CFW_MAGIC = "EVENCFW/";

export interface CFWCapabilities {
  /** Contract version after the slash (e.g. 1 for "EVENCFW/1"). */
  version: number;
  /** Feature tokens advertised by this firmware build. */
  features: Set<string>;
  /** The full advertised string, verbatim. */
  raw: string;
}

/** True when `caps` is present and advertises `feature`. */
export function hasFeature(caps: CFWCapabilities | null | undefined, feature: string): boolean {
  return !!caps && caps.features.has(feature);
}

// Scan a top-level protobuf message for the first field `fieldNo` of wire type 2
// (length-delimited) and return its payload bytes, or null. Skips other fields
// by wire type. Tolerant: bails to null on a malformed/unknown wire type.
function findLenDelimField(buf: Uint8Array, fieldNo: number): Uint8Array | null {
  let p = 0;
  const readVarint = (): number => {
    let v = 0, shift = 0;
    while (p < buf.length) {
      const b = buf[p++]!;
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return v >>> 0;
  };
  while (p < buf.length) {
    const tag = readVarint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      readVarint();
    } else if (wire === 2) {
      const len = readVarint();
      if (field === fieldNo) return buf.subarray(p, p + len);
      p += len;
    } else if (wire === 5) {
      p += 4;
    } else if (wire === 1) {
      p += 8;
    } else {
      return null; // group/unknown wire type — give up rather than misparse
    }
  }
  return null;
}

/**
 * Parse the CFW capability advertisement out of a raw G2SettingPackage ack
 * payload (as returned by a sid=0x09 settings read). Returns null when the
 * field is absent (stock firmware) or doesn't carry the expected magic prefix.
 */
export function parseCFWCapabilities(settingsPb: Uint8Array): CFWCapabilities | null {
  const bytes = findLenDelimField(settingsPb, 100);
  if (!bytes) return null;
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
  if (!s.startsWith(CFW_MAGIC)) return null;
  const tokens = s.split(/\s+/).filter(Boolean);
  const head = tokens.shift() ?? "";
  const version = Number(head.slice(CFW_MAGIC.length)) || 0;
  return { version, features: new Set(tokens), raw: s };
}
