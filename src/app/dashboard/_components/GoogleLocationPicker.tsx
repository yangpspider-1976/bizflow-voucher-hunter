"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FiCrosshair, FiMapPin, FiSearch, FiX } from "react-icons/fi";

export type Pin = { latitude: number; longitude: number };

const FALLBACK_CENTER: Pin = { latitude: 14.5547, longitude: 121.0244 };
const PINNED_ZOOM = 17;
const UNPINNED_ZOOM = 12;
const SCRIPT_ID = "voucher-hunt-google-maps";
const CALLBACK_NAME = "__voucherHuntGoogleMapsReady";
// Address autocomplete is built but parked: it needs Places API (New) enabled on
// the browser key before it can return anything. Flip this to true to switch the
// suggestion dropdown (and the Places library load) back on.
const ADDRESS_AUTOCOMPLETE_ENABLED = false;
const MAX_SUGGESTIONS = 5;
const SUGGEST_DEBOUNCE_MS = 250;
const MIN_SUGGEST_LENGTH = 3;
// Every business on the platform trades in the Philippines, so both address
// lookups are restricted rather than merely biased to it.
const REGION_CODE = "ph";
// "Satellite" is what people call imagery; HYBRID is used behind that label
// because imagery without street and place labels is hard to orient a pin by.
const MAP_LAYERS = [
  { id: "roadmap", label: "Map" },
  { id: "hybrid", label: "Satellite" },
] as const;

type MapLayerId = (typeof MAP_LAYERS)[number]["id"];

type Suggestion = {
  placeId: string;
  mainText: string;
  secondaryText: string;
  prediction: google.maps.places.PlacePrediction;
};

let mapsPromise: Promise<void> | null = null;

declare global {
  interface Window {
    __voucherHuntGoogleMapsReady?: () => void;
    gm_authFailure?: () => void;
  }
}

function loadGoogleMaps(apiKey: string): Promise<void> {
  if (window.google?.maps) return Promise.resolve();
  if (mapsPromise) return mapsPromise;

  mapsPromise = new Promise<void>((resolve, reject) => {
    window[CALLBACK_NAME] = () => {
      delete window[CALLBACK_NAME];
      resolve();
    };

    const existing = document.getElementById(SCRIPT_ID);
    if (existing) {
      existing.addEventListener("error", () =>
        reject(new Error("Google Maps could not be loaded.")),
      );
      return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      mapsPromise = null;
      delete window[CALLBACK_NAME];
      reject(new Error("Google Maps could not be loaded."));
    };
    script.src =
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}` +
      `&v=weekly&loading=async` +
      (ADDRESS_AUTOCOMPLETE_ENABLED ? "&libraries=places" : "") +
      `&callback=${CALLBACK_NAME}`;
    document.head.appendChild(script);
  });

  return mapsPromise;
}

export function GoogleLocationPicker({
  address,
  onAddressChange,
  onPinChange,
  pin,
}: {
  address: string;
  onAddressChange: (address: string) => void;
  onPinChange: (pin: Pin | null) => void;
  pin: Pin | null;
}) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() ?? "";
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const geocoderRef = useRef<google.maps.Geocoder | null>(null);
  const onAddressChangeRef = useRef(onAddressChange);
  const onPinChangeRef = useRef(onPinChange);
  const pinRef = useRef(pin);
  const searchFieldRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionTokenRef = useRef<google.maps.places.AutocompleteSessionToken | null>(null);
  // Autocomplete responses can land out of order; only the newest one may render.
  const suggestSeqRef = useRef(0);
  const autocompleteBlockedRef = useRef(false);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState("");
  const [searching, setSearching] = useState(false);
  const [notice, setNotice] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [resolvingPlace, setResolvingPlace] = useState(false);
  const [mapLayer, setMapLayer] = useState<MapLayerId>("roadmap");
  // Read when the map is built so a rebuild keeps the chosen layer.
  const mapTypeRef = useRef<MapLayerId>("roadmap");
  mapTypeRef.current = mapLayer;

  onAddressChangeRef.current = onAddressChange;
  onPinChangeRef.current = onPinChange;
  pinRef.current = pin;

  const closeSuggestions = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    suggestSeqRef.current += 1;
    setSuggestions([]);
    setActiveSuggestion(-1);
  }, []);

  const reverseGeocode = useCallback(async (next: Pin) => {
    if (!geocoderRef.current) return;
    try {
      const response = await geocoderRef.current.geocode({
        location: { lat: next.latitude, lng: next.longitude },
      });
      const formatted = response.results[0]?.formatted_address;
      if (formatted) onAddressChangeRef.current(formatted);
    } catch {
      // The coordinates remain usable when an address cannot be formatted.
    }
  }, []);

  const placePin = useCallback(
    (next: Pin) => {
      setNotice("");
      onPinChangeRef.current(next);
      void reverseGeocode(next);
    },
    [reverseGeocode],
  );

  const fetchSuggestions = useCallback(async (query: string) => {
    const places = window.google?.maps?.places;
    if (!places?.AutocompleteSuggestion || autocompleteBlockedRef.current) return;

    // One session token spans the whole type-then-pick flow so Google bills it
    // as a single autocomplete session rather than per keystroke.
    if (!sessionTokenRef.current) {
      sessionTokenRef.current = new places.AutocompleteSessionToken();
    }

    const requestId = ++suggestSeqRef.current;
    const request: google.maps.places.AutocompleteRequest = {
      includedRegionCodes: [REGION_CODE],
      input: query,
      region: REGION_CODE,
      sessionToken: sessionTokenRef.current,
    };
    const center = pinRef.current ?? mapRef.current?.getCenter()?.toJSON();
    if (center) {
      request.locationBias =
        "latitude" in center
          ? { lat: center.latitude, lng: center.longitude }
          : center;
    }

    try {
      const { suggestions: results } =
        await places.AutocompleteSuggestion.fetchAutocompleteSuggestions(request);
      if (requestId !== suggestSeqRef.current) return;

      const next: Suggestion[] = [];
      for (const item of results) {
        const prediction = item.placePrediction;
        if (!prediction) continue;
        next.push({
          placeId: prediction.placeId,
          mainText: prediction.mainText?.text ?? prediction.text.text,
          secondaryText: prediction.secondaryText?.text ?? "",
          prediction,
        });
        if (next.length === MAX_SUGGESTIONS) break;
      }
      setSuggestions(next);
      setActiveSuggestion(-1);
    } catch {
      if (requestId !== suggestSeqRef.current) return;
      // A missing Places API entitlement fails every call, so stop retrying on
      // each keystroke and leave the Find button as the way forward.
      autocompleteBlockedRef.current = true;
      setSuggestions([]);
      setActiveSuggestion(-1);
      setNotice(
        "Address suggestions are unavailable. Enable the Places API (New) for this key, or use Find to search.",
      );
    }
  }, []);

  const selectSuggestion = useCallback(
    async (suggestion: Suggestion) => {
      closeSuggestions();
      setNotice("");
      setResolvingPlace(true);
      try {
        const place = suggestion.prediction.toPlace();
        await place.fetchFields({ fields: ["location", "formattedAddress"] });
        // Selecting a place closes the billing session; the next keystroke opens a new one.
        sessionTokenRef.current = null;
        const location = place.location;
        if (!location) {
          setNotice("That place has no coordinates. Drop the pin on the map instead.");
          return;
        }
        onAddressChangeRef.current(
          place.formattedAddress ??
            [suggestion.mainText, suggestion.secondaryText].filter(Boolean).join(", "),
        );
        onPinChangeRef.current({
          latitude: location.lat(),
          longitude: location.lng(),
        });
      } catch {
        setNotice("Could not load that place. Try Find, or drop the pin on the map.");
      } finally {
        setResolvingPlace(false);
      }
    },
    [closeSuggestions],
  );

  function handleAddressInput(value: string) {
    onAddressChange(value);
    if (!ADDRESS_AUTOCOMPLETE_ENABLED) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const query = value.trim();
    if (query.length < MIN_SUGGEST_LENGTH) {
      closeSuggestions();
      return;
    }
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void fetchSuggestions(query);
    }, SUGGEST_DEBOUNCE_MS);
  }

  function handleAddressKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      if (suggestions.length) {
        event.stopPropagation();
        closeSuggestions();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!suggestions.length) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveSuggestion((current) => {
        const next = current + step;
        if (next < 0) return suggestions.length - 1;
        if (next >= suggestions.length) return 0;
        return next;
      });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const chosen = suggestions[activeSuggestion];
      if (chosen) {
        void selectSuggestion(chosen);
      } else {
        closeSuggestions();
        void searchAddress();
      }
    }
  }

  useEffect(() => {
    if (!apiKey) {
      // As an error, not a notice: nothing is loading, so the map area must stop
      // saying "Loading Google Maps..." and show the reason it never will.
      setMapError(
        "Set NEXT_PUBLIC_GOOGLE_MAPS_API_KEY (or GOOGLE_MAPS_API_KEY) in .env.local and restart the dashboard. The address field still works — the pin is optional.",
      );
      return;
    }

    let cancelled = false;
    let mapClick: google.maps.MapsEventListener | null = null;
    const previousAuthFailure = window.gm_authFailure;

    window.gm_authFailure = () => {
      if (cancelled) return;
      setMapReady(false);
      // gm_authFailure carries no reason with it, but Google logs the precise
      // one to the console (RefererNotAllowedMapError, ApiNotActivatedMapError,
      // BillingNotEnabledMapError, InvalidKeyMapError). Name all four and this
      // page's own origin, so the key can be fixed from what is on screen.
      const origin = window.location.origin;
      setMapError(
        `Google rejected this browser key for ${origin}. In the Google Cloud project the key belongs to, check that its HTTP referrer list allows ${origin}/*, that Maps JavaScript API and Geocoding API are enabled, and that billing is on. The browser console names which one failed.`,
      );
    };

    void loadGoogleMaps(apiKey)
      .then(() => {
        if (cancelled || !mapElementRef.current) return;
        setMapError("");
        const initial = pinRef.current ?? FALLBACK_CENTER;
        const map = new google.maps.Map(mapElementRef.current, {
          center: { lat: initial.latitude, lng: initial.longitude },
          clickableIcons: false,
          fullscreenControl: false,
          // Google's own switcher is off: its buttons are sized for a full-page
          // map and are labelled with the API's internal "Hybrid". The picker
          // renders its own toggle over the map instead.
          mapTypeControl: false,
          mapTypeId: mapTypeRef.current,
          streetViewControl: false,
          zoom: pinRef.current ? PINNED_ZOOM : UNPINNED_ZOOM,
        });
        mapRef.current = map;
        geocoderRef.current = new google.maps.Geocoder();
        mapClick = map.addListener(
          "click",
          (event: google.maps.MapMouseEvent) => {
            if (!event.latLng) return;
            placePin({
              latitude: event.latLng.lat(),
              longitude: event.latLng.lng(),
            });
          },
        );
        setMapReady(true);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setMapError(
            caught instanceof Error
              ? caught.message
              : "Google Maps could not be loaded.",
          );
        }
      });

    return () => {
      cancelled = true;
      if (window.gm_authFailure) {
        window.gm_authFailure = previousAuthFailure;
      }
      mapClick?.remove();
      if (markerRef.current && window.google?.maps) {
        google.maps.event.clearInstanceListeners(markerRef.current);
        markerRef.current.setMap(null);
        markerRef.current = null;
      }
      mapRef.current = null;
      geocoderRef.current = null;
    };
  }, [apiKey, placePin]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;

    if (!pin) {
      if (markerRef.current) {
        google.maps.event.clearInstanceListeners(markerRef.current);
        markerRef.current.setMap(null);
        markerRef.current = null;
      }
      return;
    }

    const position = { lat: pin.latitude, lng: pin.longitude };
    if (!markerRef.current) {
      const marker = new google.maps.Marker({
        draggable: true,
        map,
        position,
        title: "Business location",
      });
      marker.addListener("dragend", () => {
        const next = marker.getPosition();
        if (next) {
          placePin({ latitude: next.lat(), longitude: next.lng() });
        }
      });
      markerRef.current = marker;
    } else {
      markerRef.current.setPosition(position);
    }

    map.panTo(position);
    if ((map.getZoom() ?? 0) < PINNED_ZOOM) map.setZoom(PINNED_ZOOM);
  }, [mapReady, pin, placePin]);

  useEffect(() => {
    if (!suggestions.length) return;
    function handlePointerDown(event: MouseEvent | TouchEvent) {
      const target = event.target;
      if (target instanceof Node && searchFieldRef.current?.contains(target)) return;
      closeSuggestions();
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [closeSuggestions, suggestions.length]);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  async function searchAddress() {
    closeSuggestions();
    const query = address.trim();
    if (!query) {
      setNotice("Type an address first.");
      return;
    }
    if (!geocoderRef.current) {
      setNotice("Wait for Google Maps to finish loading, then try again.");
      return;
    }

    setSearching(true);
    setNotice("");
    try {
      const response = await geocoderRef.current.geocode({
        address: query,
        componentRestrictions: { country: REGION_CODE },
      });
      const result = response.results[0];
      if (!result) {
        setNotice(
          "No match found in the Philippines. Drop the pin on the map instead.",
        );
        return;
      }
      onAddressChangeRef.current(result.formatted_address);
      onPinChangeRef.current({
        latitude: result.geometry.location.lat(),
        longitude: result.geometry.location.lng(),
      });
    } catch {
      setNotice("Could not search right now. Drop the pin on the map instead.");
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="location-picker">
      <label className="field">
        <span>Address</span>
        <div className="location-picker-search" ref={searchFieldRef}>
          <div className="location-picker-input">
            <input
              aria-activedescendant={
                activeSuggestion >= 0
                  ? `address-suggestion-${suggestions[activeSuggestion]?.placeId}`
                  : undefined
              }
              aria-autocomplete="list"
              aria-controls={suggestions.length ? "address-suggestions" : undefined}
              aria-expanded={suggestions.length > 0}
              autoComplete="off"
              onChange={(event) => handleAddressInput(event.target.value)}
              onKeyDown={handleAddressKeyDown}
              placeholder="123 Ayala Ave, Makati City"
              required
              role="combobox"
              value={address}
            />
            {suggestions.length ? (
              <ul
                className="location-picker-suggestions"
                id="address-suggestions"
                role="listbox"
              >
                {suggestions.map((suggestion, index) => (
                  <li key={suggestion.placeId} role="presentation">
                    <button
                      aria-selected={index === activeSuggestion}
                      className={
                        index === activeSuggestion
                          ? "location-picker-suggestion active"
                          : "location-picker-suggestion"
                      }
                      id={`address-suggestion-${suggestion.placeId}`}
                      onClick={() => void selectSuggestion(suggestion)}
                      onMouseEnter={() => setActiveSuggestion(index)}
                      role="option"
                      type="button"
                    >
                      <FiMapPin aria-hidden="true" />
                      <span>
                        <strong>{suggestion.mainText}</strong>
                        {suggestion.secondaryText ? (
                          <small>{suggestion.secondaryText}</small>
                        ) : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <button
            className="location-picker-search-button"
            disabled={searching || !mapReady}
            onClick={() => void searchAddress()}
            type="button"
          >
            <FiSearch aria-hidden="true" />
            {searching ? "Searching..." : "Find"}
          </button>
        </div>
        <small className="muted">
          {resolvingPlace
            ? "Placing the pin..."
            : ADDRESS_AUTOCOMPLETE_ENABLED
              ? "Start typing to pick a suggested address, then click or drag the pin to place it exactly. Customers use this location for Google Maps directions."
              : "Search to drop a pin, then click or drag it to place it exactly. Customers use this location for Google Maps directions."}
        </small>
      </label>

      <div className="location-picker-map">
        <div className="google-location-map" ref={mapElementRef} />
        {mapError ? (
          <div className="location-picker-error" role="alert">
            <strong>Google Maps configuration required</strong>
            <span>{mapError}</span>
          </div>
        ) : !mapReady ? (
          <p className="location-picker-loading">Loading Google Maps...</p>
        ) : null}
        {mapReady ? (
          <div aria-label="Map layer" className="location-picker-layers" role="group">
            {MAP_LAYERS.map((layer) => (
              <button
                aria-pressed={mapLayer === layer.id}
                className={mapLayer === layer.id ? "active" : ""}
                key={layer.id}
                onClick={() => {
                  setMapLayer(layer.id);
                  mapRef.current?.setMapTypeId(layer.id);
                }}
                type="button"
              >
                {layer.label}
              </button>
            ))}
          </div>
        ) : null}
        {mapReady && !pin ? (
          <p className="location-picker-empty">
            <FiCrosshair aria-hidden="true" /> Click the map to drop a pin
          </p>
        ) : null}
      </div>

      <div className="location-picker-footer">
        {pin ? (
          <>
            <span className="location-picker-coords">
              {pin.latitude.toFixed(6)}, {pin.longitude.toFixed(6)}
            </span>
            <button
              className="location-picker-clear"
              onClick={() => {
                onPinChange(null);
                setNotice("");
              }}
              type="button"
            >
              <FiX aria-hidden="true" /> Clear pin
            </button>
          </>
        ) : (
          <span className="muted">
            No pin set — directions will use the written address.
          </span>
        )}
      </div>

      {notice ? <p className="location-picker-notice">{notice}</p> : null}
    </div>
  );
}
