import assert from "node:assert/strict";
import { test } from "node:test";
import { GITHUB_APP_ENV, requireEnvVars } from "./env.ts";

const ALL_MISSING =
  /Missing required env vars GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_APP_INSTALLATION_ID: set them in \.env/;
const ONE_MISSING =
  /Missing required env var GITHUB_APP_INSTALLATION_ID: set it/;

test("requireEnvVars passes when every variable is set", () => {
  assert.doesNotThrow(() =>
    requireEnvVars(GITHUB_APP_ENV, {
      GITHUB_APP_ID: "1",
      GITHUB_APP_INSTALLATION_ID: "2",
      GITHUB_APP_PRIVATE_KEY_PATH: "/keys/app.pem",
    })
  );
});

test("requireEnvVars names every unset variable at once", () => {
  assert.throws(() => requireEnvVars(GITHUB_APP_ENV, {}), ALL_MISSING);
});

test("requireEnvVars treats empty and blank values as missing", () => {
  assert.throws(
    () =>
      requireEnvVars(GITHUB_APP_ENV, {
        GITHUB_APP_ID: "1",
        GITHUB_APP_INSTALLATION_ID: "  ",
        GITHUB_APP_PRIVATE_KEY_PATH: "/keys/app.pem",
      }),
    ONE_MISSING
  );
});
