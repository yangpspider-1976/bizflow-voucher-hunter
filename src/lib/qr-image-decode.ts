/**
 * Reading a QR code out of a *photo* is a different problem from reading one
 * off a live camera. The camera path gets dozens of frames a second and only
 * needs one of them to be good; an upload is a single shot that has already
 * happened, so whatever is wrong with it — glare, a transparent background, a
 * screenshot cropped flush to the code, a 12-megapixel photo of a code the
 * size of a thumbnail — has to be worked around here or the staff member is
 * told "no readable QR code" for an image that plainly contains one.
 *
 * ZXing's own `decodeFromImageUrl()` makes exactly one attempt: the image at
 * its natural size, on a transparent canvas, with a hybrid binarizer and no
 * hints. This module replaces that with a ladder of attempts, cheapest and
 * most-likely first, stopping at the first success.
 */

import type { LuminanceSource } from "@zxing/library";

/** A grayscale image: one byte of luminance per pixel, row by row. */
export type QrRaster = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

export type QrDecodeResult =
  | { ok: true; text: string }
  | {
      /**
       * `unsupported-file` means the browser could not turn the file into an
       * image at all — an iPhone HEIC outside Safari, a PDF, a renamed file.
       * `not-found` means we saw the pixels and found no code in them. They
       * need different advice, so they stay separate.
       */
      ok: false;
      reason: "unsupported-file" | "not-found";
    };

/**
 * One decode attempt is a luminance source plus the two knobs ZXing gives us:
 * which binarizer turns gray into black-and-white, and whether the code is
 * printed dark-on-light or light-on-dark.
 */
type Binarizer = "hybrid" | "global";

type Attempt = {
  binarizer: Binarizer;
  inverted: boolean;
  /**
   * PURE_BARCODE skips the locate step and assumes the image *is* the code.
   * It is the one thing that reads a screenshot cropped so tightly that the
   * quiet zone is gone, and it is fast, so it earns a slot early.
   */
  pure?: boolean;
};

/** Loaded once and shared; the library is ~200KB and only needed on demand. */
let zxingPromise: Promise<typeof import("@zxing/library")> | null = null;

function loadZxing() {
  if (!zxingPromise) zxingPromise = import("@zxing/library");
  return zxingPromise;
}

/**
 * Runs the binarizer/inversion matrix over one grayscale image.
 *
 * Exported on its own so it can be tested without a canvas: the browser half
 * of this module produces rasters, and this half turns a raster into text.
 */
export async function decodeQrRaster(
  raster: QrRaster,
  attempts: Attempt[] = DEFAULT_ATTEMPTS,
): Promise<string | null> {
  const zxing = await loadZxing();
  const {
    BinaryBitmap,
    DecodeHintType,
    GlobalHistogramBinarizer,
    HybridBinarizer,
    QRCodeReader,
    RGBLuminanceSource,
  } = zxing;

  const reader = new QRCodeReader();
  const upright = new RGBLuminanceSource(
    raster.data,
    raster.width,
    raster.height,
  );
  // `invert()` is a view, not a copy, so building it once costs nothing even
  // when every attempt that uses it fails.
  let inverse: LuminanceSource | null = null;

  for (const attempt of attempts) {
    let source: LuminanceSource = upright;
    if (attempt.inverted) {
      inverse = inverse ?? upright.invert();
      source = inverse;
    }

    const binarizer =
      attempt.binarizer === "hybrid"
        ? new HybridBinarizer(source)
        : new GlobalHistogramBinarizer(source);

    const hints = new Map<number, unknown>([[DecodeHintType.TRY_HARDER, true]]);
    if (attempt.pure) hints.set(DecodeHintType.PURE_BARCODE, true);

    try {
      const result = reader.decode(new BinaryBitmap(binarizer), hints);
      const text = result.getText().trim();
      if (text) return text;
    } catch {
      // Every miss throws — NotFoundException, FormatException, ChecksumException
      // and, on malformed input, the odd IndexOutOfBounds. The next attempt is
      // the answer to all of them.
    } finally {
      reader.reset();
    }
  }

  return null;
}

/** The full matrix, in the order that resolves real uploads soonest. */
const DEFAULT_ATTEMPTS: Attempt[] = [
  { binarizer: "hybrid", inverted: false },
  { binarizer: "hybrid", inverted: true },
  { binarizer: "global", inverted: false },
  { binarizer: "global", inverted: true },
  { binarizer: "hybrid", inverted: false, pure: true },
  { binarizer: "hybrid", inverted: true, pure: true },
];

/** Cheaper matrix for the later, more speculative crops. */
const QUICK_ATTEMPTS: Attempt[] = [
  { binarizer: "hybrid", inverted: false },
  { binarizer: "hybrid", inverted: true },
];

/**
 * Pulls the histogram apart so a washed-out photo — a code behind glare, or a
 * grey-on-grey print — spans the full range before the binarizer sees it.
 * Returns null when the image already has usable contrast and the stretch
 * would only be a second copy of the same attempt.
 */
export function stretchContrast(raster: QrRaster): QrRaster | null {
  const { data } = raster;
  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i += 1) {
    const value = data[i];
    if (value < min) min = value;
    if (value > max) max = value;
  }

  const span = max - min;
  if (span <= 0 || span > 200) return null;

  const scale = 255 / span;
  const stretched = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 1) {
    stretched[i] = (data[i] - min) * scale;
  }
  return { data: stretched, width: raster.width, height: raster.height };
}

/* -------------------------------------------------------------------------
 * Browser half: turning a File into rasters worth trying.
 * ---------------------------------------------------------------------- */

type ImageSource = {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
};

async function loadImage(file: File): Promise<ImageSource | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // Falls through to the <img> path, which some browsers decode when
      // createImageBitmap refuses (older Safari, exotic colour profiles).
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const element = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new window.Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("decode failed"));
      image.src = url;
    });
    if (!element.naturalWidth || !element.naturalHeight) {
      URL.revokeObjectURL(url);
      return null;
    }
    return {
      source: element,
      width: element.naturalWidth,
      height: element.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

/** A region of the source image to rasterize, in 0..1 coordinates. */
type Region = { x: number; y: number; width: number; height: number };

const FULL_FRAME: Region = { x: 0, y: 0, width: 1, height: 1 };

function rasterize(
  image: ImageSource,
  region: Region,
  targetMax: number,
): QrRaster | null {
  const sourceX = Math.round(region.x * image.width);
  const sourceY = Math.round(region.y * image.height);
  const sourceWidth = Math.max(1, Math.round(region.width * image.width));
  const sourceHeight = Math.max(1, Math.round(region.height * image.height));

  const scale = Math.min(1, targetMax / Math.max(sourceWidth, sourceHeight));
  const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
  const drawHeight = Math.max(1, Math.round(sourceHeight * scale));

  // A white margin all round. A code that runs flush to the edge of a cropped
  // screenshot has no quiet zone, and without one the locator refuses to see
  // it however clean the pixels are.
  const margin = Math.max(12, Math.round(Math.max(drawWidth, drawHeight) * 0.05));
  const canvasWidth = drawWidth + margin * 2;
  const canvasHeight = drawHeight + margin * 2;

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  // The fill is not cosmetic. A PNG QR code with a transparent background
  // draws as black-on-transparent, and transparent reads back as rgb(0,0,0):
  // black on black. ZXing's own canvas source special-cases alpha 0 to white;
  // we read the pixels ourselves, so we have to paint the background instead.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvasWidth, canvasHeight);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image.source,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    margin,
    margin,
    drawWidth,
    drawHeight,
  );

  const pixels = context.getImageData(0, 0, canvasWidth, canvasHeight).data;
  const luminance = new Uint8ClampedArray(canvasWidth * canvasHeight);
  for (let i = 0, p = 0; i < luminance.length; i += 1, p += 4) {
    // Green-favoured average, matching ZXing's own conversion.
    luminance[i] = (pixels[p] + 2 * pixels[p + 1] + pixels[p + 2]) / 4;
  }

  return { data: luminance, width: canvasWidth, height: canvasHeight };
}

/** Yields to the browser so the "Reading QR image..." line actually paints. */
function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * The ladder of attempts. Each entry is a region of the image and the size to
 * rasterize it at; `attempts` and `stretch` say how hard to try on that one.
 *
 * The sizes matter as much as the crops. Downscaling a big photo is what makes
 * a noisy 12MP shot readable — the binarizer stops chasing sensor grain — while
 * a dense code photographed from across a counter needs the *larger* raster to
 * keep its modules more than a pixel wide.
 */
type Stage = {
  region: Region;
  targetMax: number;
  attempts: Attempt[];
  stretch?: boolean;
  /** Skip when the source has less detail than the stage is asking for. */
  minSourceMax?: number;
};

function buildStages(image: ImageSource): Stage[] {
  const sourceMax = Math.max(image.width, image.height);
  const centre = (fraction: number): Region => ({
    x: (1 - fraction) / 2,
    y: (1 - fraction) / 2,
    width: fraction,
    height: fraction,
  });

  const stages: Stage[] = [
    { region: FULL_FRAME, targetMax: 1200, attempts: DEFAULT_ATTEMPTS, stretch: true },
    { region: FULL_FRAME, targetMax: 640, attempts: QUICK_ATTEMPTS },
    {
      region: FULL_FRAME,
      targetMax: 2000,
      attempts: QUICK_ATTEMPTS,
      minSourceMax: 1400,
    },
    { region: centre(0.6), targetMax: 900, attempts: DEFAULT_ATTEMPTS, stretch: true },
    { region: centre(0.35), targetMax: 700, attempts: QUICK_ATTEMPTS },
  ];

  // A photo taken hastily often has the code off to one side. Overlapping
  // quadrants are the last thing tried, because they are the least likely and
  // there are four of them.
  for (const [x, y] of [
    [0, 0],
    [0.45, 0],
    [0, 0.45],
    [0.45, 0.45],
  ]) {
    stages.push({
      region: { x, y, width: 0.55, height: 0.55 },
      targetMax: 700,
      attempts: QUICK_ATTEMPTS,
    });
  }

  // A tiny source has nothing to gain from crops — every stage would be the
  // same handful of pixels blown up — so stop after the full-frame passes.
  if (sourceMax < 400) return stages.slice(0, 2);
  return stages;
}

/**
 * Reads a QR code out of an uploaded image file.
 *
 * Resolves with the decoded text, or with why it could not: `unsupported-file`
 * when the browser cannot open the file as an image at all, `not-found` when
 * it can and no code was in it.
 */
export async function decodeQrFromFile(file: File): Promise<QrDecodeResult> {
  const image = await loadImage(file);
  if (!image) return { ok: false, reason: "unsupported-file" };

  try {
    for (const stage of buildStages(image)) {
      if (
        stage.minSourceMax &&
        Math.max(image.width, image.height) < stage.minSourceMax
      ) {
        continue;
      }

      const raster = rasterize(image, stage.region, stage.targetMax);
      if (!raster) continue;

      const text = await decodeQrRaster(raster, stage.attempts);
      if (text) return { ok: true, text };

      if (stage.stretch) {
        const stretched = stretchContrast(raster);
        if (stretched) {
          const stretchedText = await decodeQrRaster(stretched, QUICK_ATTEMPTS);
          if (stretchedText) return { ok: true, text: stretchedText };
        }
      }

      await yieldToBrowser();
    }
  } finally {
    image.release();
  }

  return { ok: false, reason: "not-found" };
}
