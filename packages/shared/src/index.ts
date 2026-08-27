// @bizflow/shared — isomorphic code shared by the web app (apps at repo root)
// and the future React Native app. Everything here must run in both a browser/
// Next.js and a React Native runtime: pure TypeScript only, no Node built-ins,
// no next/*, no DOM, no database. Server-only logic stays in the web app and is
// reached over the API.

export * from "./types";
export * from "./benefit-rules";
export * from "./campaign-image";
export * from "./gamification";
export * from "./maps";
export * from "./phone";
export * from "./phone-display";
export * from "./voucher-presentation";
