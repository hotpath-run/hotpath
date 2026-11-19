// The one switch for the login requirement: set to false and every command
// runs without an account (login, logout, whoami and sync still work).
export const REQUIRE_LOGIN = true;

export const API_BASE = "https://amjgasdhzhndqkvvvads.supabase.co";

export const LOGIN_REQUIRED_MESSAGE =
  "Hotpath needs a free hotpath.run account. Run `hotpath login` (it opens your browser). For CI, set HOTPATH_TOKEN.";

/** Online check at most this often; offline for up to OFFLINE_GRACE_MS since the last good one is fine. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
