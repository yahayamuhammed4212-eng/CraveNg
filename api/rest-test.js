import { getEnv } from "./_lib.js";

export default async function handler(req, res) {
  const env = getEnv();

  const url = env.supabaseUrl;
  const key = env.serviceKey;

  if (!url || !key) {
    return res.status(500).json({
      ok: false,
      error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
    });
  }

  const isLegacyJwt = key.startsWith("eyJ");

  const headers = {
    apikey: key
  };

  if (isLegacyJwt) {
    headers.Authorization = `Bearer ${key}`;
  }

  const base = `${url.replace(/\/+$/, "")}/rest/v1`;

  const probes = [
    {
      label: "PostgREST root",
      path: "/"
    },
    {
      label: "cng_orders",
      path: "/cng_orders?select=id&limit=1"
    },
    {
      label: "cng_vendors",
      path: "/cng_vendors?select=id&limit=1"
    },
    {
      label: "cng_settings",
      path: "/cng_settings?select=key&limit=1"
    },
    {
      label: "control: table that does not exist",
      path: "/definitely_not_a_table?select=id&limit=1"
    }
  ];

  const results = [];

  for (const probe of probes) {
    const target = `${base}${probe.path}`;

    try {
      const response = await fetch(target, {
        method: "GET",
        headers
      });

      const text = await response.text();

      let parsed;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }

      results.push({
        label: probe.label,
        url: target,
        sentHeaders: isLegacyJwt
          ? ["apikey", "Authorization: Bearer <redacted>"]
          : ["apikey"],
        status: response.status,
        ok: response.ok,
        response: parsed
      });
    } catch (error) {
      results.push({
        label: probe.label,
        url: target,
        sentHeaders: isLegacyJwt
          ? ["apikey", "Authorization: Bearer <redacted>"]
          : ["apikey"],
        error: error.message
      });
    }
  }

  return res.status(200).json({
    ok: results.every((r) => r.ok),
    projectRefFromUrl: (() => {
      try {
        return new URL(url).hostname.split(".")[0];
      } catch {
        return null;
      }
    })(),
    key: {
      present: true,
      length: key.length,
      prefix: key.slice(0, 11) + "…",
      format: isLegacyJwt ? "legacy JWT" : "new secret",
      hadSurroundingWhitespace: key !== key.trim(),
      hadWrappingQuotes:
        (key.startsWith('"') && key.endsWith('"')) ||
        (key.startsWith("'") && key.endsWith("'")),
      containsInnerWhitespace: /\s/.test(key.trim())
    },
    headerPolicy: isLegacyJwt
      ? "apikey + Authorization Bearer"
      : "apikey only",
    probes: results
  });
}
