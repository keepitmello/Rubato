// The Antigravity route's api id, apart from the route itself: the media tools test checks
// its list against this id without loading pi-ai, which the route needs (antigravity-api.mjs).
export const ANTIGRAVITY_API = "rubato-antigravity";

// The one User-Agent every Rubato request to Cloud Code Assist carries (generation, project
// lookup, usage). Google picks the model catalog from its client surface: on 2026-11-20 the same
// account and project got 22 models and a 404 for gemini-4-neon as `antigravity/hub/2.8.0`, and
// 39 models with Neon as `antigravity/cli`. The value is what the installed agy 1.5.13 sends,
// read off its own traffic, without the `host_path=` suffix that agy adds only under ACP.
export const ANTIGRAVITY_USER_AGENT =
  "antigravity/cli/1.5.13 (aidev_client; os_type=darwin; arch=arm64; cl=1025641825; auth_method=consumer)";
