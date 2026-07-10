/**
 * Tests for Level 1 model-adaptive dashboard pricing (src/pricing.ts).
 * Run: npx tsx tests/pricing.test.ts   (or: npm test)
 *
 * No test framework — a tiny assert harness kept dependency-free so it runs
 * under the repo's existing `tsx`. Exits non-zero on the first failure.
 *
 * PXPIPE_MODEL_PRICES is read once at module load, so it's set BEFORE the
 * dynamic import below to exercise the override path.
 */
let passed = 0;
function ok(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ✘ FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
}
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

// Override "claude-opus" to a sentinel rate + add an unlisted model, so we can
// prove env overrides both replace built-ins and extend the table.
process.env.PXPIPE_MODEL_PRICES = JSON.stringify({
  "claude-opus": 12.5,
  "claude-custom-x": 7,
  "claude-bad": "not-a-number",
});

const { inputRateForModel, rescaleStatsUsd, INPUT_USD_PER_MTOK_BY_MODEL } =
  await import("../src/pricing.ts");
const { ASSUMED_INPUT_USD_PER_MTOK } = await import(
  "../node_modules/pxpipe-proxy/dist/dashboard.js"
);

const FLAT = ASSUMED_INPUT_USD_PER_MTOK; // 10

// --- inputRateForModel -----------------------------------------------------
ok(inputRateForModel("claude-fable-5") === 10, "fable-5 → 10");
ok(inputRateForModel("claude-sonnet-5") === 3, "sonnet-5 base-prefix → 3");
ok(
  inputRateForModel("claude-haiku-4-5-20251001") === 0.8,
  "dated haiku id longest-prefix → 0.8",
);
ok(inputRateForModel("gpt-4o") === FLAT, "unknown model → flat fallback");
ok(inputRateForModel("") === FLAT, "empty id → flat fallback");
ok(inputRateForModel(null) === FLAT, "null id → flat fallback");
ok(
  inputRateForModel("gpt-4o", 42) === 42,
  "explicit fallback arg honored for unknown model",
);
// env overrides
ok(
  inputRateForModel("claude-opus-4-8") === 12.5,
  "env override replaces built-in opus rate",
);
ok(
  inputRateForModel("claude-custom-x-1") === 7,
  "env override adds new model prefix",
);
ok(
  INPUT_USD_PER_MTOK_BY_MODEL["claude-opus"] === 5,
  "built-in table object is not mutated by overrides",
);
ok(
  inputRateForModel("claude-bad-1") === FLAT,
  "non-numeric override ignored → fallback",
);

// longest-prefix precedence: a more specific key must win regardless of insert
// order (opus overridden to 12.5, opus-4 not listed → still resolves to opus).
ok(inputRateForModel("claude-opusition") === 12.5, "prefix match is by string");

// --- rescaleStatsUsd -------------------------------------------------------
function fakeStats(): Response {
  return new Response(
    JSON.stringify({
      requests: 100,
      saved_input_tokens: 1_000_000,
      saved_usd: 5.0,
      compressed_actual_usd: 2.0,
      passthrough_actual_usd: 1.0,
      compressed_avg_usd_per_request: 0.02,
      passthrough_avg_usd_per_request: 0.01,
      compressed_minus_passthrough_avg_usd: 0.01,
      pricing_assumptions: { input_per_mtok: 10, output_multiplier: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// sonnet-5 = $3/Mtok → factor 0.3 off the flat $10 payload.
const scaled = await rescaleStatsUsd(fakeStats(), "claude-sonnet-5");
const s = (await scaled.json()) as Record<string, unknown>;
ok(near(s.saved_usd as number, 1.5), "saved_usd 5.0 × 0.3 → 1.5");
ok(near(s.compressed_actual_usd as number, 0.6), "compressed_actual_usd → 0.6");
ok(near(s.passthrough_actual_usd as number, 0.3), "passthrough_actual_usd → 0.3");
ok(
  near(s.compressed_avg_usd_per_request as number, 0.006),
  "compressed_avg → 0.006",
);
ok(
  (s.saved_input_tokens as number) === 1_000_000,
  "token counts are NOT rescaled (rate-independent)",
);
const pa = s.pricing_assumptions as Record<string, unknown>;
ok(pa.input_per_mtok === 3, "pricing_assumptions.input_per_mtok → 3");
ok(pa.input_per_mtok_flat_fallback === 10, "flat fallback recorded");
ok(pa.input_per_mtok_model_id === "claude-sonnet-5", "model id recorded");
ok(pa.input_per_mtok_source === "model-adaptive", "source tagged");
ok(pa.output_multiplier === 5, "unrelated assumption fields preserved");
ok(scaled.status === 200, "status preserved");

// unknown model → same rate → original Response handed back unchanged.
const noop = await rescaleStatsUsd(fakeStats(), "gpt-4o");
const n = (await noop.json()) as Record<string, unknown>;
ok(near(n.saved_usd as number, 5.0), "unknown model → USD untouched");
ok(
  (n.pricing_assumptions as Record<string, unknown>).input_per_mtok === 10,
  "unknown model → rate untouched",
);

// non-JSON body → passthrough, no throw.
const bad = new Response("not json", { status: 200 });
const passthrough = await rescaleStatsUsd(bad, "claude-sonnet-5");
ok((await passthrough.text()) === "not json", "non-JSON body passed through");

console.log(`✓ all ${passed} assertions passed`);
