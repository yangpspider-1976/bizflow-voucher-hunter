#!/usr/bin/env node
/**
 * Starts Metro for the Android emulator against one fixed backend.
 *
 * The API host is picked by argument rather than by editing `.env.local`, so
 * which backend a session is talking to is visible in the command that started
 * it. `EXPO_NO_DOTENV` then stops Expo re-reading those files and quietly
 * putting the other host back; anything else the env files hold (such as
 * GOOGLE_MAPS_API_KEY) is preloaded by the npm script's --env-file-if-exists
 * flags and still reaches the app.
 */
const { spawn } = require("node:child_process");
const path = require("node:path");

const TARGETS = {
  dev: {
    // The emulator's alias for the host machine's localhost.
    apiBaseUrl: "http://10.0.2.2:3000",
  },
  prod: {
    apiBaseUrl: "https://voucher-hunt.com",
    appLinkHost: "voucher-hunt.com",
  },
};

const target = TARGETS[process.argv[2]];
if (!target) {
  console.error(
    `Usage: node scripts/emulator.js <${Object.keys(TARGETS).join("|")}>`,
  );
  process.exit(2);
}

const env = {
  ...process.env,
  EXPO_PUBLIC_API_BASE_URL: target.apiBaseUrl,
  EXPO_NO_DOTENV: "1",
};
// Only set when the target has one: app.config.js registers the https intent
// filter solely when this is present, and an unverifiable host leaves Android
// showing a disambiguation dialog.
if (target.appLinkHost) {
  env.EXPO_PUBLIC_APP_LINK_HOST = target.appLinkHost;
} else {
  delete env.EXPO_PUBLIC_APP_LINK_HOST;
}

console.log(`\nEmulator → ${target.apiBaseUrl}\n`);

// --clear is not optional when switching targets: EXPO_PUBLIC_* values are
// inlined into the bundle at transform time, so a warm Metro cache will happily
// serve the previous target's URL from an unchanged module.
// One command string rather than a command plus an argv array: the shell is
// needed to find npx on Windows, and passing both trips Node's DEP0190 warning
// about unescaped arguments. Nothing here is interpolated.
const child = spawn("npx expo start --dev-client --android --clear", {
  cwd: path.resolve(__dirname, ".."),
  env,
  shell: true,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
