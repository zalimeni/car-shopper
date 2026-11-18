// The AI scoring models the user may pick — the one list shared by the UI
// (src/score.js → the Settings picker) and the server's allowlist
// (api/_scoring.js resolveScoreModel), so the two can't drift. Pure.
//
// Default is Sonnet: strong judgment for the structured scoring task at a
// lower cost than Opus.
export var SCORE_MODEL_OPTIONS = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5 — balanced (recommended)" },
  { id: "claude-opus-5-5", label: "Opus 5.5 — most nuanced" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5 — fastest / cheapest" },
];

export var DEFAULT_SCORE_MODEL = "claude-sonnet-5-5";
