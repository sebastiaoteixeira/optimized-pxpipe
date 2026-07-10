/**
 * Level 1 model-adaptive input pricing for the dashboard.
 *
 * The bundled pxpipe-proxy dashboard hardcodes a single flat input rate
 * (`ASSUMED_INPUT_USD_PER_MTOK`, the Fable-5 $10/MTok assumption) for every
 * dollar figure it reports. That's wrong the moment traffic runs on a model
 * with a different list price. Rather than fork the dependency, we keep the
 * flat computation intact and RESCALE the dollar fields in the `serveStats()`
 * JSON on the way out — every USD number in that payload is linear in the
 * input rate, so multiplying by (modelRate / assumedRate) is exact.
 *
 * Level 1 scope: a session is assumed effectively single-model, so the
 * most-recently-seen model id drives the rate. Level 2 (later) will attribute
 * per-request and split mixed-model sessions.
 */
import { ASSUMED_INPUT_USD_PER_MTOK } from "../node_modules/pxpipe-proxy/dist/dashboard.js";

/** Built-in input $/MTok list rates, keyed by model-id prefix and matched by
 *  LONGEST prefix so dated ids (e.g. "claude-haiku-4-5-20251001") resolve to
 *  their base entry. Intentionally sparse: only rates documented in the
 *  pxpipe pricing note are seeded here; anything unlisted falls back to
 *  ASSUMED_INPUT_USD_PER_MTOK. These are best-effort list prices and MUST be
 *  verified against docs.claude.com/en/docs/about-claude/pricing — override
 *  any/all of them at runtime via PXPIPE_MODEL_PRICES without editing code. */
export const INPUT_USD_PER_MTOK_BY_MODEL: Readonly<Record<string, number>> = {
  "claude-fable-5": 10.0,
  "claude-opus": 5.0,
  "claude-sonnet": 3.0,
  "claude-haiku": 0.8,
};

/** Parse PXPIPE_MODEL_PRICES once: a JSON object of {modelIdPrefix: usdPerMtok}
 *  merged over (and overriding) the built-in table. Malformed JSON or
 *  non-numeric/negative values are ignored so a bad env var can never crash
 *  the dashboard — it just falls back to the built-in rates. */
function loadModelPriceOverrides(): Record<string, number> {
  const raw = process.env.PXPIPE_MODEL_PRICES;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n) && n >= 0) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

const MODEL_PRICE_TABLE: Record<string, number> = {
  ...INPUT_USD_PER_MTOK_BY_MODEL,
  ...loadModelPriceOverrides(),
};

/** Resolve the input $/MTok rate for a model id via longest-prefix match.
 *  Unknown/empty ids return the flat fallback, so behaviour is identical to
 *  the old hardcoded rate until a known model appears. */
export function inputRateForModel(
  model: string | null | undefined,
  fallback: number = ASSUMED_INPUT_USD_PER_MTOK,
): number {
  if (typeof model !== "string" || model.length === 0) return fallback;
  let bestKey: string | null = null;
  for (const key of Object.keys(MODEL_PRICE_TABLE)) {
    if (
      model.startsWith(key) &&
      (bestKey === null || key.length > bestKey.length)
    ) {
      bestKey = key;
    }
  }
  return bestKey === null ? fallback : MODEL_PRICE_TABLE[bestKey];
}

/** USD fields in the /proxy-stats payload. Every one is a linear function of
 *  the input rate, so all rescale by the same (newRate / oldRate) factor. */
const USD_FIELDS = [
  "saved_usd",
  "compressed_actual_usd",
  "passthrough_actual_usd",
  "compressed_avg_usd_per_request",
  "passthrough_avg_usd_per_request",
  "compressed_minus_passthrough_avg_usd",
] as const;

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Rescale the dollar figures of a `serveStats()` Response to the rate for
 *  `model`. Reads the rate the dependency actually used from
 *  `pricing_assumptions.input_per_mtok`, so this stays correct even if the
 *  dependency's flat rate changes. Returns a NEW Response (status/headers
 *  preserved); the original body is consumed. On any parse failure the input
 *  Response is passed through untouched — the dashboard shows the flat-rate
 *  numbers rather than breaking. */
export function rescaleStatsObject(
  data: Record<string, unknown>,
  model: string | null | undefined,
): Record<string, unknown> {
  const assumptions = (data.pricing_assumptions ?? {}) as Record<
    string,
    unknown
  >;
  const oldRate =
    typeof assumptions.input_per_mtok === "number" &&
    assumptions.input_per_mtok > 0
      ? assumptions.input_per_mtok
      : ASSUMED_INPUT_USD_PER_MTOK;
  const newRate = inputRateForModel(model, oldRate);

  // No-op fast path: rate unchanged (unknown model, or model priced identically
  // to the flat assumption). Return the SAME reference so callers can cheaply
  // detect "nothing changed" and skip re-serialising.
  if (newRate === oldRate) return data;

  const factor = newRate / oldRate;
  const out: Record<string, unknown> = { ...data };
  for (const field of USD_FIELDS) {
    if (typeof out[field] === "number") {
      out[field] = round4((out[field] as number) * factor);
    }
  }
  out.pricing_assumptions = {
    ...assumptions,
    input_per_mtok: newRate,
    // Provenance so the operator can tell a model-accurate figure from a
    // flat-fallback guess, and which model drove it.
    input_per_mtok_flat_fallback: oldRate,
    input_per_mtok_model_id: model ?? null,
    input_per_mtok_source: "model-adaptive",
  };
  return out;
}

/** Response wrapper around {@link rescaleStatsObject} for the HTTP `/stats`
 *  route: rescales the body of a `serveStats()` Response and returns a NEW
 *  Response (status/headers preserved). On parse failure or a no-op rate the
 *  original Response is passed through untouched. */
export async function rescaleStatsUsd(
  res: Response,
  model: string | null | undefined,
): Promise<Response> {
  let data: Record<string, unknown>;
  try {
    data = (await res.clone().json()) as Record<string, unknown>;
  } catch {
    return res;
  }

  const scaled = rescaleStatsObject(data, model);
  if (scaled === data) return res;

  const headers = new Headers(res.headers);
  return new Response(JSON.stringify(scaled), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
