export type MapTarget = {
  address?: string;
  latitude?: number;
  longitude?: number;
};

/**
 * Google Maps link for a venue.
 *
 * Coordinates win when a pin has been dropped: a written address is only as
 * good as the geocoder's guess, and "123 Ayala Ave" resolves to several places.
 * The address string is the fallback for venues pinned before this existed.
 *
 * Uses the documented Maps URL scheme rather than a `geo:` or
 * `comgooglemaps://` URI, so it opens the Maps app when installed and the
 * browser otherwise.
 */
export function buildMapsUrl(target: MapTarget | string): string {
  if (typeof target === "string") {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(target.trim())}`;
  }

  const { address, latitude, longitude } = target;
  if (isCoordinate(latitude) && isCoordinate(longitude)) {
    return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((address ?? "").trim())}`;
}

/**
 * Google Maps directions link with the venue as the destination.
 *
 * The origin is intentionally omitted so Google Maps uses the device's
 * current location. `dir_action=navigate` opens the route ready to navigate
 * when a Maps app is installed, and falls back to Google Maps on the web.
 */
export function buildDirectionsUrl(target: MapTarget | string): string {
  const destination =
    typeof target === "string"
      ? target.trim()
      : isCoordinate(target.latitude) && isCoordinate(target.longitude)
        ? `${target.latitude},${target.longitude}`
        : (target.address ?? "").trim();

  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving&dir_action=navigate`;
}

/** Guards against NaN and the nulls a database column can hand back. */
export function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function hasPin(target: MapTarget): boolean {
  return isCoordinate(target.latitude) && isCoordinate(target.longitude);
}

/**
 * A `tel:` URI for a contact number.
 *
 * Strips spaces, dashes and brackets, which are common in written numbers and
 * which some dialers refuse. A leading `+` is kept: it is significant.
 */
export function buildTelUrl(contactNumber: string): string {
  return `tel:${contactNumber.trim().replace(/(?!^\+)[^\d]/g, "")}`;
}

/** Mean Earth radius, metres. */
const EARTH_RADIUS_M = 6_371_000;

/**
 * Great-circle distance between two coordinates, in metres.
 *
 * Used to decide whether a player is inside a location-gated mission's radius,
 * which is a server decision — the client's own distance is only ever shown,
 * never trusted. Haversine rather than a planar approximation because the
 * radii involved (a few hundred metres to a few kilometres) are small enough
 * that the error of a flat-earth shortcut lands right where the boundary
 * decision is made.
 */
export function metresBetween(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a))));
}
