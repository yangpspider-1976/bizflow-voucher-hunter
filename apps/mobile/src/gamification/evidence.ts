import * as ImagePicker from "expo-image-picker";

/** The server's ceiling. Anything larger is refused after the upload. */
const MAX_BYTES = 2 * 1024 * 1024;

export type PickedEvidence = {
  contentBase64: string;
  contentType: string;
  /** A local URI, so the screen can show what is about to be sent. */
  previewUri: string;
  byteSize: number;
};

/**
 * Picks one image from the gallery and returns it ready to upload.
 *
 * Gallery rather than camera on purpose. A receipt is photographed with the
 * camera app and picked from the roll, and on modern Android the system photo
 * picker needs no permission at all — so the whole feature costs the app
 * neither a CAMERA permission nor a media-library one.
 *
 * Downscaled and re-encoded to JPEG before it is measured. A modern phone
 * photograph is four to eight megabytes; sending one over mobile data to be
 * refused by the server's cap would be the worst possible way to learn that.
 */
export async function pickEvidence(): Promise<
  | { ok: true; evidence: PickedEvidence }
  | { ok: false; reason: "cancelled" | "denied" | "too_large" | "unavailable" }
> {
  try {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
      // 0.6 keeps a receipt legible and is what brings a phone photograph under
      // the cap without a second resize step.
      quality: 0.6,
      base64: true,
      exif: false,
    });
    if (result.canceled) return { ok: false, reason: "cancelled" };

    const asset = result.assets[0];
    if (!asset?.base64) return { ok: false, reason: "unavailable" };

    const byteSize = Math.floor((asset.base64.length * 3) / 4);
    if (byteSize > MAX_BYTES) return { ok: false, reason: "too_large" };

    return {
      ok: true,
      evidence: {
        contentBase64: asset.base64,
        // The picker reports the source file's type; anything it cannot name is
        // JPEG, which is what `quality` re-encoded it to.
        contentType: asset.mimeType === "image/png" ? "image/png" : "image/jpeg",
        previewUri: asset.uri,
        byteSize,
      },
    };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
