import { ENV, keyKind, keyDiagnostics, serviceHeaders } from "./_lib.js";

export default async function handler(req, res) {
  const url = ENV.sbUrl;
  const key = ENV.sbService;

  if (!url || !key) {
    return res.status(500).json({
      ok: false,
      error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
    });
  }

  const base =
    url.replace(/\/+$/, "").replace(/\/rest\/v1$/, "") + "/rest/v1";

  const mode = keyKind() === "legacy JWT" ? "both" : "apikey";

  const headers = serviceHeaders(null, mode);

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
    const target = base + probe.path;

    try {
      const response = await fetch(target, {
        method: "GET",
        headers
      });

      const text = await response.text();

      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }

      results.push({
        label: probe.label,
        url: target,
        sentHeaders:
          mode === "both"
            ? ["apikey", "Authorization: Bearer <redacted>"]
            : ["apikey"],
        status: response.status,
        code: body && body.code ? body.code : null,
        message: body && body.message ? body.message : "",
        ok: response.ok
      });
    } catch (error) {
      results.push({
        label: probe.label,
        url: target,
        sentHeaders:
          mode === "both"
            ? ["apikey", "Authorization: Bearer <redacted>"]
            : ["apikey"],
        status: 0,
        code: null,
        message: error.message,
        ok: false
      });
    }
  }

  const orders = results.find(r => r.label === "cng_orders");
  const vendors = results.find(r => r.label === "cng_vendors");

  let verdict;

  if (orders?.ok && vendors?.ok) {
    verdict =
      "SUCCESS: service_role can read cng_orders and cng_vendors.";
  } else if (orders?.status === 403 || vendors?.status === 403) {
    verdict =
      "Permission is still being denied on one or more tables.";
  } else if (orders?.status === 401 || vendors?.status === 401) {
    verdict =
      "The legacy service_role JWT was rejected.";
  } else {
    verdict =
      "The request reached Supabase, but one or more probes failed.";
  }

  return res.status(200).json({
    projectRefFromUrl: (() => {
      try {
        return new URL(url).hostname.split(".")[0];
      } catch {
        return null;
      }
    })(),

    urlUsed: url,

    key: keyDiagnostics(),

    keyFormat: keyKind(),

    headerPolicy:
      mode === "both"
        ? "apikey + Authorization Bearer"
        : "apikey only",

    probes: results,

    verdict
  });
}
