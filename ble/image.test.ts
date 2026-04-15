import { test, expect, describe } from "bun:test";
import {
  buildEvenHubBmp,
  rgbaToEvenHubBmp,
  rgbaToEvenHubTiles,
  planImageFragments,
  EVEN_PALETTE_GRAY16,
  G2_LENS_WIDTH,
  G2_LENS_HEIGHT,
  G2_IMAGE_TILE_WIDTH,
  G2_IMAGE_TILE_HEIGHT,
} from "./image";
import {
  buildImageContainers,
  buildImageRawData,
} from "./messages";
import { fromBinary } from "@bufbuild/protobuf";
import { evenhub_main_msg_ctxSchema } from "./gen/EvenHub_pb";

// The firmware header layout: 14 + 40 + 64 = 118 bytes of header before
// any pixel data. All derivations below assume this.
const HEADER_SIZE = 14 + 40 + 64;

function readU32LE(buf: Uint8Array, off: number): number {
  return (
    (buf[off]! |
      (buf[off + 1]! << 8) |
      (buf[off + 2]! << 16) |
      (buf[off + 3]! << 24)) >>>
    0
  );
}

function readI32LE(buf: Uint8Array, off: number): number {
  const v = readU32LE(buf, off);
  return v | 0;
}

function readU16LE(buf: Uint8Array, off: number): number {
  return (buf[off]! | (buf[off + 1]! << 8)) & 0xffff;
}

describe("buildEvenHubBmp", () => {
  test("produces a BMP with a valid header for 288×144", () => {
    const bmp = buildEvenHubBmp(288, 144, () => 0);

    // BMP magic 'BM'.
    expect(bmp[0]).toBe(0x42);
    expect(bmp[1]).toBe(0x4d);

    // File size field matches actual length.
    expect(readU32LE(bmp, 2)).toBe(bmp.length);
    // Pixel data offset = 14 + 40 + 64.
    expect(readU32LE(bmp, 10)).toBe(HEADER_SIZE);
    // DIB header size = 40 (BITMAPINFOHEADER).
    expect(readU32LE(bmp, 14)).toBe(40);
    // Width / height.
    expect(readI32LE(bmp, 18)).toBe(288);
    expect(readI32LE(bmp, 22)).toBe(144);
    // Planes = 1, bpp = 4.
    expect(readU16LE(bmp, 26)).toBe(1);
    expect(readU16LE(bmp, 28)).toBe(4);
    // BI_RGB (no compression).
    expect(readU32LE(bmp, 30)).toBe(0);
    // colorsUsed must be 16 — firmware checks this to distinguish EvenHub
    // BMPs from nav BMPs.
    expect(readU32LE(bmp, 46)).toBe(16);
  });

  test("total size for 288×144 is 20854 bytes (matches g2-img-send measurements)", () => {
    // 288 px / 2 = 144 bytes per row, already 4-byte aligned.
    // Pixel data = 144 * 144 = 20736 bytes. + 118 header = 20854.
    const bmp = buildEvenHubBmp(288, 144, () => 0);
    expect(bmp.length).toBe(20854);
  });

  test("grayscale palette exactly matches firmware (0..15 × 17)", () => {
    const bmp = buildEvenHubBmp(4, 4, () => 0);
    // Palette sits at 14 + 40 = 54.
    for (let i = 0; i < 16; i++) {
      const off = 54 + i * 4;
      expect(bmp[off]).toBe(i * 17);       // B
      expect(bmp[off + 1]).toBe(i * 17);   // G
      expect(bmp[off + 2]).toBe(i * 17);   // R
      expect(bmp[off + 3]).toBe(0);        // A
    }
    // EVEN_PALETTE_GRAY16 constant should match the inline palette.
    for (let i = 0; i < EVEN_PALETTE_GRAY16.length; i++) {
      expect(bmp[54 + i]).toBe(EVEN_PALETTE_GRAY16[i]!);
    }
  });

  test("pixel data is bottom-up and packs two indices per byte", () => {
    // A 4×2 image where pixel(x, 0) = x, pixel(x, 1) = 15 - x.
    const bmp = buildEvenHubBmp(4, 2, (x, y) => (y === 0 ? x : 15 - x));
    // rowStride = ceil(4/2) = 2, padded to 4 → 4 bytes per row.
    // BMP row 0 is the BOTTOM row of the image (y=1).
    const bottomRow = bmp.subarray(HEADER_SIZE, HEADER_SIZE + 4);
    // y=1 pixels: [15, 14, 13, 12] → packed high|low → [0xfe, 0xdc, 0x00, 0x00]
    expect(bottomRow[0]).toBe(0xfe);
    expect(bottomRow[1]).toBe(0xdc);
    const topRow = bmp.subarray(HEADER_SIZE + 4, HEADER_SIZE + 8);
    // y=0 pixels: [0, 1, 2, 3] → [0x01, 0x23]
    expect(topRow[0]).toBe(0x01);
    expect(topRow[1]).toBe(0x23);
  });
});

describe("rgbaToEvenHubBmp", () => {
  test("rejects size mismatches", () => {
    expect(() => rgbaToEvenHubBmp(new Uint8Array(10), 2, 2)).toThrow();
  });

  test("pure-white RGBA produces index 15 everywhere", () => {
    const w = 4, h = 2;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 255;
      rgba[i * 4 + 1] = 255;
      rgba[i * 4 + 2] = 255;
      rgba[i * 4 + 3] = 255;
    }
    const bmp = rgbaToEvenHubBmp(rgba, w, h);
    // Every pixel byte should be 0xff (two index-15 nibbles).
    const rowStart = HEADER_SIZE; // bottom row = y=1 since bottom-up
    for (let o = 0; o < 2; o++) expect(bmp[rowStart + o]).toBe(0xff);
    // Second row (top of image).
    for (let o = 0; o < 2; o++) expect(bmp[rowStart + 4 + o]).toBe(0xff);
  });

  test("alpha=0 pixels map to index 0", () => {
    const rgba = new Uint8Array([
      255, 255, 255, 0,    // transparent white — should become 0
      255, 255, 255, 255,  // opaque white    — should become 15
      0,   0,   0,   255,  // opaque black    — should become 0
      128, 128, 128, 255,  // opaque gray     — 128>>4 = 8
    ]);
    const bmp = rgbaToEvenHubBmp(rgba, 4, 1);
    // Single row, bottom-up means it's at HEADER_SIZE.
    // Packed: [0|15, 0|8] = [0x0f, 0x08]
    expect(bmp[HEADER_SIZE]).toBe(0x0f);
    expect(bmp[HEADER_SIZE + 1]).toBe(0x08);
  });
});

describe("rgbaToEvenHubTiles", () => {
  test("full-lens source produces exactly 4 tiles of 288×144", () => {
    const w = G2_LENS_WIDTH;
    const h = G2_LENS_HEIGHT;
    const rgba = new Uint8Array(w * h * 4);
    // Horizontal gradient so each tile has different content.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const g = Math.floor((x / w) * 255);
        rgba[i] = g;
        rgba[i + 1] = g;
        rgba[i + 2] = g;
        rgba[i + 3] = 255;
      }
    }

    const tiles = rgbaToEvenHubTiles(rgba, w, h);
    expect(tiles.length).toBe(4);

    const expectedPositions = [
      { x: 0,   y: 0   },
      { x: 288, y: 0   },
      { x: 0,   y: 144 },
      { x: 288, y: 144 },
    ];
    for (let i = 0; i < 4; i++) {
      expect(tiles[i]!.x).toBe(expectedPositions[i]!.x);
      expect(tiles[i]!.y).toBe(expectedPositions[i]!.y);
      expect(tiles[i]!.width).toBe(G2_IMAGE_TILE_WIDTH);
      expect(tiles[i]!.height).toBe(G2_IMAGE_TILE_HEIGHT);
      // Each tile is a valid BMP of the expected byte size.
      expect(tiles[i]!.bmp.length).toBe(20854);
      expect(tiles[i]!.bmp[0]).toBe(0x42);
      expect(tiles[i]!.bmp[1]).toBe(0x4d);
    }

    // Left-half tiles should render darker than right-half tiles because
    // the source gradient goes dark → light across x. Compare the average
    // pixel-nibble intensity of tile 0 (top-left) vs tile 1 (top-right).
    const avgNibble = (bmp: Uint8Array): number => {
      let sum = 0;
      let count = 0;
      for (let i = HEADER_SIZE; i < bmp.length; i++) {
        sum += (bmp[i]! >> 4) & 0xf;
        sum += bmp[i]! & 0xf;
        count += 2;
      }
      return sum / count;
    };
    const leftAvg = avgNibble(tiles[0]!.bmp);
    const rightAvg = avgNibble(tiles[1]!.bmp);
    expect(rightAvg).toBeGreaterThan(leftAvg + 3);
  });

  test("downscales a smaller source into the full lens", () => {
    // 32×16 source, all red. Every resampled pixel should hit the same
    // luma (0.299 * 255 = 76 → 76 >> 4 = 4).
    const w = 32, h = 16;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 255;
      rgba[i * 4 + 1] = 0;
      rgba[i * 4 + 2] = 0;
      rgba[i * 4 + 3] = 255;
    }
    const tiles = rgbaToEvenHubTiles(rgba, w, h);
    expect(tiles.length).toBe(4);
    // Spot-check: the packed byte for a pure-red pixel pair should be
    // (4<<4)|4 = 0x44.
    for (const t of tiles) {
      expect(t.bmp[HEADER_SIZE]).toBe(0x44);
    }
  });
});

describe("planImageFragments", () => {
  test("splits a 20854 B BMP into 6 chunks at 4096 B", () => {
    const bmp = new Uint8Array(20854);
    const frags = planImageFragments(bmp, 4096);
    expect(frags.length).toBe(6);
    // First five are exactly 4096, last carries the remainder.
    for (let i = 0; i < 5; i++) expect(frags[i]!.data.length).toBe(4096);
    expect(frags[5]!.data.length).toBe(20854 - 5 * 4096);
    // Indices are 0-based and monotonic.
    frags.forEach((f, i) => expect(f.index).toBe(i));
    // Concatenated fragments equal the original (no byte loss).
    let total = 0;
    for (const f of frags) total += f.data.length;
    expect(total).toBe(bmp.length);
  });

  test("single-fragment case when BMP fits in one packet", () => {
    const bmp = new Uint8Array(100);
    const frags = planImageFragments(bmp, 4096);
    expect(frags.length).toBe(1);
    expect(frags[0]!.data.length).toBe(100);
  });
});

describe("buildImageContainers (Cmd=7 REBUILD w/ ImageObject[])", () => {
  test("4-tile full-lens layout round-trips through the pb schema", () => {
    const containers = [
      { x: 0,   y: 0,   width: 288, height: 144, containerId: 1, name: "img-tl" },
      { x: 288, y: 0,   width: 288, height: 144, containerId: 2, name: "img-tr" },
      { x: 0,   y: 144, width: 288, height: 144, containerId: 3, name: "img-bl" },
      { x: 288, y: 144, width: 288, height: 144, containerId: 4, name: "img-br" },
    ];
    const { pb, magic } = buildImageContainers({ containers, magic: 300 });
    expect(magic).toBe(300);
    const decoded = fromBinary(evenhub_main_msg_ctxSchema, pb);
    expect(decoded.Cmd).toBe(7); // APP_REQUEST_REBUILD_PAGE_PACKET
    expect(decoded.MagicRandom).toBe(300);
    const rb = decoded.RebuildContainer;
    expect(rb).toBeDefined();
    expect(rb!.ContainerTotalNum).toBe(4);
    expect(rb!.ImageObject.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      const obj = rb!.ImageObject[i]!;
      expect(obj.XPosition).toBe(containers[i]!.x);
      expect(obj.YPosition).toBe(containers[i]!.y);
      expect(obj.Width).toBe(containers[i]!.width);
      expect(obj.Height).toBe(containers[i]!.height);
      expect(obj.ContainerID).toBe(containers[i]!.containerId);
      expect(obj.ContainerName).toBe(containers[i]!.name);
    }
  });

  test("rejects container names longer than 14 characters", () => {
    expect(() =>
      buildImageContainers({
        containers: [{ x: 0, y: 0, width: 1, height: 1, containerId: 1, name: "way-too-long-name-here" }],
      }),
    ).toThrow();
  });
});

describe("buildImageRawData (Cmd=3 pixel fragment)", () => {
  test("a single fragment round-trips through the pb schema", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const { pb } = buildImageRawData({
      containerId: 2,
      containerName: "img-tr",
      mapSessionId: 5000,
      mapTotalSize: 20854,
      mapFragmentIndex: 3,
      mapRawData: data,
      magic: 401,
    });
    const decoded = fromBinary(evenhub_main_msg_ctxSchema, pb);
    expect(decoded.Cmd).toBe(3); // APP_UPDATE_IMAGE_RAW_DATA_PACKET
    expect(decoded.MagicRandom).toBe(401);
    const img = decoded.ImgRawMsg;
    expect(img).toBeDefined();
    expect(img!.ContainerID).toBe(2);
    expect(img!.ContainerName).toBe("img-tr");
    expect(img!.MapSessionId).toBe(5000);
    expect(img!.MapTotalSize).toBe(20854);
    expect(img!.MapFragmentIndex).toBe(3);
    expect(img!.MapFragmentPacketSize).toBe(data.length);
    expect(img!.CompressMode).toBe(0);
    expect(Array.from(img!.MapRawData)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("end-to-end: RGBA → tiles → REBUILD + Cmd=3 plan", () => {
  test("full-lens RGBA gradient produces 4 containers × 6 fragments each", () => {
    const w = G2_LENS_WIDTH;
    const h = G2_LENS_HEIGHT;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = (i * 3) & 0xff;
      rgba[i * 4 + 1] = (i * 3) & 0xff;
      rgba[i * 4 + 2] = (i * 3) & 0xff;
      rgba[i * 4 + 3] = 255;
    }
    const tiles = rgbaToEvenHubTiles(rgba, w, h);

    // The REBUILD frame that declares all four containers.
    const { pb: rebuildPb } = buildImageContainers({
      containers: tiles.map((t, i) => ({
        x: t.x,
        y: t.y,
        width: t.width,
        height: t.height,
        containerId: i + 1,
        name: `img-t${i}`,
      })),
      magic: 500,
    });
    const rebuildDecoded = fromBinary(evenhub_main_msg_ctxSchema, rebuildPb);
    expect(rebuildDecoded.RebuildContainer!.ImageObject.length).toBe(4);

    // Pixel-data fragments per tile. All four tiles are the same BMP
    // size, so the fragment count should be identical.
    let totalFragments = 0;
    for (let ti = 0; ti < tiles.length; ti++) {
      const tile = tiles[ti]!;
      const frags = planImageFragments(tile.bmp, 4096);
      expect(frags.length).toBe(6);
      totalFragments += frags.length;

      // Spot-check the first fragment round-trips through the pb schema.
      const { pb } = buildImageRawData({
        containerId: ti + 1,
        containerName: `img-t${ti}`,
        mapSessionId: 9000 + ti,
        mapTotalSize: tile.bmp.length,
        mapFragmentIndex: frags[0]!.index,
        mapRawData: frags[0]!.data,
        magic: 600 + ti,
      });
      const decoded = fromBinary(evenhub_main_msg_ctxSchema, pb);
      expect(decoded.Cmd).toBe(3);
      expect(decoded.ImgRawMsg!.MapTotalSize).toBe(tile.bmp.length);
      expect(decoded.ImgRawMsg!.MapFragmentPacketSize).toBe(frags[0]!.data.length);
    }
    expect(totalFragments).toBe(24); // 4 tiles × 6 fragments = 24 Cmd=3 messages
  });
});
