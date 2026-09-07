import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import {
  decodeQrRaster,
  stretchContrast,
  type QrRaster,
} from "@/lib/qr-image-decode";

/**
 * The decoder's browser half needs a canvas; its reading half does not, and
 * that is the half that decides whether a tester's upload is accepted. These
 * tests feed it the same grayscale rasters the canvas would produce, one per
 * way a real upload goes wrong.
 */

type RenderOptions = {
  /** Pixels per QR module. 1 is the pathological "screenshot at 1x" case. */
  scale?: number;
  /** Modules of white border. Zero is a screenshot cropped flush to the code. */
  quietZone?: number;
  /** Luminance used for the dark and light modules. */
  dark?: number;
  light?: number;
};

function renderQrRaster(text: string, options: RenderOptions = {}): QrRaster {
  const { scale = 4, quietZone = 4, dark = 0, light = 255 } = options;
  const matrix = QRCode.create(text, { errorCorrectionLevel: "M" }).modules;
  const size = matrix.size;
  const side = (size + quietZone * 2) * scale;
  const data = new Uint8ClampedArray(side * side).fill(light);

  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (!matrix.data[row * size + column]) continue;
      const originY = (row + quietZone) * scale;
      const originX = (column + quietZone) * scale;
      for (let y = 0; y < scale; y += 1) {
        const offset = (originY + y) * side + originX;
        data.fill(dark, offset, offset + scale);
      }
    }
  }

  return { data, width: side, height: side };
}

const CODE = "BF20-15MAY-12PM-X7A8";

describe("QR image decoding", () => {
  it("reads an ordinary dark-on-light code", async () => {
    await expect(decodeQrRaster(renderQrRaster(CODE))).resolves.toBe(CODE);
  });

  it("reads a code printed light-on-dark", async () => {
    // What a dark-mode screenshot or a white-on-black voucher card looks like.
    // ZXing's default single pass never inverts, so this used to be a flat
    // "no readable QR code" no matter how clean the image was.
    const raster = renderQrRaster(CODE, { dark: 255, light: 0 });
    await expect(decodeQrRaster(raster)).resolves.toBe(CODE);
  });

  it("reads a code cropped flush to its edges", async () => {
    // No quiet zone at all: the locator cannot work, and only the PURE_BARCODE
    // pass gets this one. The browser half also pads with white, so a real
    // upload has two chances at it.
    const raster = renderQrRaster(CODE, { quietZone: 0 });
    await expect(decodeQrRaster(raster)).resolves.toBe(CODE);
  });

  it("reads a washed-out low-contrast image after the stretch", async () => {
    const raster = renderQrRaster(CODE, { dark: 96, light: 150 });
    const stretched = stretchContrast(raster);
    expect(stretched).not.toBeNull();
    await expect(decodeQrRaster(stretched as QrRaster)).resolves.toBe(CODE);
  });

  it("leaves an already-contrasty image alone", () => {
    expect(stretchContrast(renderQrRaster(CODE))).toBeNull();
  });

  it("reports no code rather than throwing on a blank image", async () => {
    const blank: QrRaster = {
      data: new Uint8ClampedArray(200 * 200).fill(255),
      width: 200,
      height: 200,
    };
    await expect(decodeQrRaster(blank)).resolves.toBeNull();
  });
});
