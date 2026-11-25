// The account is optional: every command runs without one, and signing in only
// adds the dashboard (run summaries sync once logged in). An open-source CLI that
// refuses to run locally without a sign-up loses most people before the demo.
// Set to true to bring the requirement back.
export const REQUIRE_LOGIN = false;

export const API_BASE = "https://amjgasdhzhndqkvvvads.supabase.co";

export const LOGIN_REQUIRED_MESSAGE =
  "Hotpath needs a free hotpath.run account. Run `hotpath login` (it opens your browser). For CI, set HOTPATH_TOKEN.";

/** Online check at most this often; offline for up to OFFLINE_GRACE_MS since the last good one is fine. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
