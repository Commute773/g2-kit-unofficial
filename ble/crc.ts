// CRC-16/CCITT-FALSE (poly=0x1021, init=0xffff, no reflect, no xor).
// Appended little-endian to the last fragment of an EvenHub message,
// computed over the concatenated pb payload of all fragments.
export function crc16CCittFalse(data: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]! << 8;
    for (let k = 0; k < 8; k++) {
      if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xffff;
      else crc = (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

export function crcBytesLE(pb: Uint8Array): Uint8Array {
  const crc = crc16CCittFalse(pb);
  return new Uint8Array([crc & 0xff, (crc >> 8) & 0xff]);
}
