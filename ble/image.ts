// Image packing for the G2 EvenHub ImageContainer path.
//
// The firmware's image renderer takes 4-bpp indexed BMP bytes with a
// 16-step grayscale palette (entry i has B=G=R=i*17, A=0). The full-lens
// 576×288 region is tiled as a 2×2 grid of 288×144 containers because:
//
//   - A single 288×144 4bpp BMP is ~20 KB — the largest payload we've seen
//     the firmware ingest cleanly in one session.
//   - `RebuildPageContainer.ImageObject` is a repeated field, so all four
//     containers can be declared in one Cmd=7 round trip.
//   - 288 × 2 = 576, 144 × 2 = 288 — exactly the lens grid.
//
// Sources:
//   - ~/bletools/bmp.ts (buildBmp4bpp / EVEN_PALETTE_GRAY16)
//   - ~/.claude/projects/-Users-elinaro/memory/project_g2_direct_ble_findings.md

/** Full-lens width in physical pixels. */
export const G2_LENS_WIDTH = 576;
/** Full-lens height in physical pixels. */
export const G2_LENS_HEIGHT = 288;
/** Width of one image tile in the 2×2 full-lens layout. */
export const G2_IMAGE_TILE_WIDTH = 288;
/** Height of one image tile in the 2×2 full-lens layout. */
export const G2_IMAGE_TILE_HEIGHT = 144;

/** 16-step grayscale palette (BGRA), matches `evenHubBmp4FromRgbaPixels`. */
export const EVEN_PALETTE_GRAY16: Uint8Array = (() => {
  const pal = new Uint8Array(16 * 4);
  for (let i = 0; i < 16; i++) {
    const v = i * 17; // 0, 17, 34, ..., 255
    pal[i * 4 + 0] = v;
    pal[i * 4 + 1] = v;
    pal[i * 4 + 2] = v;
    pal[i * 4 + 3] = 0;
  }
  return pal;
})();

/**
 * Build a 4-bpp indexed BMP with the EvenHub grayscale palette. The
 * `pixel(x, y)` callback must return an integer 0..15 where 0 = black
 * and 15 = white. Out-of-range values are masked to 4 bits.
 *
 * Row stride is padded to a 4-byte boundary per the BMP spec. Rows are
 * stored bottom-up (positive Height in the DIB header).
 */
export function buildEvenHubBmp(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number,
): Uint8Array {
  const bytesPerPixelRow = Math.ceil(width / 2);
  const rowStride = (bytesPerPixelRow + 3) & ~3;
  const pixelDataSize = rowStride * height;

  const fileHeaderSize = 14;
  const dibHeaderSize = 40;
  const paletteSize = EVEN_PALETTE_GRAY16.length;
  const pixelOffset = fileHeaderSize + dibHeaderSize + paletteSize;
  const fileSize = pixelOffset + pixelDataSize;

  const buf = new Uint8Array(fileSize);
  const view = new DataView(buf.buffer);
  buf[0] = 0x42; // 'B'
  buf[1] = 0x4d; // 'M'
  view.setUint32(2, fileSize, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  view.setUint32(10, pixelOffset, true);

  view.setUint32(14, dibHeaderSize, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);       // planes
  view.setUint16(28, 4, true);       // bpp
  view.setUint32(30, 0, true);       // BI_RGB
  view.setUint32(34, pixelDataSize, true);
  view.setInt32(38, 0, true);        // xPixPerMeter
  view.setInt32(42, 0, true);        // yPixPerMeter
  view.setUint32(46, 16, true);      // colorsUsed = 16 (EvenHub convention)
  view.setUint32(50, 0, true);       // importantColors

  buf.set(EVEN_PALETTE_GRAY16, fileHeaderSize + dibHeaderSize);

  for (let bmpRow = 0; bmpRow < height; bmpRow++) {
    const srcY = height - 1 - bmpRow;
    const rowOffset = pixelOffset + bmpRow * rowStride;
    for (let x = 0; x < width; x += 2) {
      const hi = pixel(x, srcY) & 0x0f;
      const lo = (x + 1 < width ? pixel(x + 1, srcY) : 0) & 0x0f;
      buf[rowOffset + (x >> 1)] = (hi << 4) | lo;
    }
  }
  return buf;
}

/**
 * Convert an RGBA8 pixel buffer to a 4-bpp EvenHub BMP. `rgba` is a flat
 * `width*height*4` byte buffer in row-major order, top-down, with fully
 * transparent pixels (alpha=0) mapped to index 0 (black).
 *
 * Luminance uses Rec. 601 coefficients and truncates to 4 bits
 * (`luma >> 4`), which gives a 16-level ramp without dithering. This is
 * good enough for reddit thumbnails at 288×144; if artifact-free tones
 * matter later, swap in an error-diffusion dither.
 */
export function rgbaToEvenHubBmp(
  rgba: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  if (rgba.length !== width * height * 4) {
    throw new Error(
      `rgbaToEvenHubBmp: rgba length ${rgba.length} != ${width}*${height}*4`,
    );
  }
  const pixel = (x: number, y: number): number => {
    const i = (y * width + x) * 4;
    const r = rgba[i] ?? 0;
    const g = rgba[i + 1] ?? 0;
    const b = rgba[i + 2] ?? 0;
    const a = rgba[i + 3] ?? 255;
    if (a === 0) return 0;
    const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    return Math.min(15, Math.max(0, luma >> 4));
  };
  return buildEvenHubBmp(width, height, pixel);
}

export interface ImageTile {
  /** x offset inside the parent 576×288 layout */
  x: number;
  /** y offset inside the parent 576×288 layout */
  y: number;
  width: number;
  height: number;
  /** 4-bpp indexed BMP, ready for Cmd=3 raw-data streaming */
  bmp: Uint8Array;
}

/**
 * Resample an arbitrary RGBA image into the 576×288 lens and split it
 * into a 2×2 grid of 288×144 EvenHub BMP tiles. Uses nearest-neighbor
 * scaling — fine for reddit thumbnails where the source is already low
 * detail.
 *
 * Returns the tiles in reading order: top-left, top-right, bottom-left,
 * bottom-right. Each tile carries the absolute (x, y) it needs to be
 * positioned at on the lens.
 */
export function rgbaToEvenHubTiles(
  srcRgba: Uint8Array,
  srcWidth: number,
  srcHeight: number,
): ImageTile[] {
  if (srcRgba.length !== srcWidth * srcHeight * 4) {
    throw new Error(
      `rgbaToEvenHubTiles: srcRgba length ${srcRgba.length} != ${srcWidth}*${srcHeight}*4`,
    );
  }
  const tiles: ImageTile[] = [];
  const tilesX = Math.ceil(G2_LENS_WIDTH / G2_IMAGE_TILE_WIDTH);
  const tilesY = Math.ceil(G2_LENS_HEIGHT / G2_IMAGE_TILE_HEIGHT);
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const tileX = tx * G2_IMAGE_TILE_WIDTH;
      const tileY = ty * G2_IMAGE_TILE_HEIGHT;
      const bmp = buildEvenHubBmp(
        G2_IMAGE_TILE_WIDTH,
        G2_IMAGE_TILE_HEIGHT,
        (lx, ly) => {
          // Destination coord inside the full lens.
          const dx = tileX + lx;
          const dy = tileY + ly;
          // Nearest-neighbor sample from source.
          const sx = Math.min(srcWidth - 1, Math.floor((dx * srcWidth) / G2_LENS_WIDTH));
          const sy = Math.min(srcHeight - 1, Math.floor((dy * srcHeight) / G2_LENS_HEIGHT));
          const i = (sy * srcWidth + sx) * 4;
          const r = srcRgba[i] ?? 0;
          const g = srcRgba[i + 1] ?? 0;
          const b = srcRgba[i + 2] ?? 0;
          const a = srcRgba[i + 3] ?? 255;
          if (a === 0) return 0;
          const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
          return Math.min(15, Math.max(0, luma >> 4));
        },
      );
      tiles.push({
        x: tileX,
        y: tileY,
        width: G2_IMAGE_TILE_WIDTH,
        height: G2_IMAGE_TILE_HEIGHT,
        bmp,
      });
    }
  }
  return tiles;
}

/**
 * Split a 4-bpp BMP into Cmd=3 fragments of at most `maxFragmentSize`
 * bytes each. The 4096 B default matches the firmware cap observed in
 * `~/bletools/g2-img-send.ts` testing — 6144 and 8192 are rejected with
 * async error code 7.
 */
export function planImageFragments(
  bmp: Uint8Array,
  maxFragmentSize = 4096,
): Array<{ index: number; data: Uint8Array }> {
  if (maxFragmentSize <= 0) throw new Error("maxFragmentSize must be > 0");
  const fragments: Array<{ index: number; data: Uint8Array }> = [];
  const count = Math.max(1, Math.ceil(bmp.length / maxFragmentSize));
  for (let i = 0; i < count; i++) {
    const start = i * maxFragmentSize;
    const end = Math.min(start + maxFragmentSize, bmp.length);
    fragments.push({ index: i, data: bmp.subarray(start, end) });
  }
  return fragments;
}
