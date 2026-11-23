import { describe, expect, it } from "vitest";
import worker from "../src/workers/render/index";
import contractYaml from "../openapi/render.yaml";
import type { Env } from "../src/workers/render/index";

// The render worker's gates (263, increment three): the gateway's
// golden contract served byte-identically, the module discovery
// document with the fixtures index, the EN 18222 and UNTP renderings
// through the boundary, the import direction (ingest → deterministic
// identity → matched on re-import → the ingested passport resolves),
// the stated refusals, the report channel and the scan-token gate.
const contract =
  typeof contractYaml === "string" ? contractYaml : String(contractYaml);

const call = (
  path: string,
  env: Env = {},
  init?: RequestInit,
): Promise<Response> =>
  worker.fetch(
    new Request("https://gateway.unidpp.org" + path, init),
    env,
    {} as ExecutionContext,
  );

const FIXTURE_ID = "urn:iso:std:iso-iec:15459:unidpp:passport:84120099012345";

// A UNTP passport VC wrapped in the triad shape this gateway itself
// renders — the import direction's round-trip input.
const untpTriad = (): string =>
  JSON.stringify({
    passport: {
      "@context": "https://www.w3.org/ns/credentials/v2",
      type: "DigitalProductPassport",
      id: "https://render.test/passport/roundtrip",
      productIdentifiers: [
        { scheme: "https://gs1.org/voc/", value: "04012345123456" },
      ],
      passportIssuer: { id: "urn:eo:render-test" },
      validFrom: "2026-01-01T00:00:00Z",
    },
    conformity: [
      {
        credentialSubject: {
          conformity: {
            standard: "urn:unidpp:profile:eu-espr-electronics",
            version: "1.0",
          },
        },
        validFrom: "2026-02-01T00:00:00Z",
      },
    ],
    link: { target: "https://resolve.unidpp.org/r/roundtrip" },
  });

describe("the render worker's contract", () => {
  it("serves the golden contract byte-identically", async () => {
    const response = await call("/openapi.yaml");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(contract);
  });

  it("answers the liveness probe and the module discovery document", async () => {
    expect((await call("/healthz")).status).toBe(200);
    const response = await call("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-as-of")).toBeTruthy();
    const doc = (await response.json()) as {
      service?: string;
      bindings?: Record<string, { profile?: string; endpoint?: string }>;
      source?: { mode?: string; fixtures?: { passport_id?: string }[] };
      conventions?: string[];
    };
    expect(doc.service).toBe("unidpp-gateway");
    expect(doc.bindings?.untp?.profile).toBe("urn:unidpp:profile:render:untp");
    expect(doc.bindings?.en18222?.endpoint).toContain(
      "GET /en18222/v1/dppsByProductId/{gtin}",
    );
    expect(doc.source?.mode).toBe("issuer-upstream-with-fixture-fallback");
    expect(doc.source?.fixtures?.[0]?.passport_id).toBe(FIXTURE_ID);
    expect(doc.conventions?.join(" ")).toContain("I12");
  });

  it("refuses the unknown representation and answers the frozen no-information bytes", async () => {
    const bad = await call("/en18222/v1/dppsByProductId/04012345123456?representation=verbose");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe(
      "unknown representation `verbose` (expected full|compressed)",
    );
    const missing = await call("/untp/product/urn:unidpp:passport:none-such");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('{"error":"not found"}');
  });

  it("validates the freshness parameter", async () => {
    const bad = await call("/untp/product/" + encodeURIComponent(FIXTURE_ID) + "?freshness=yesterday");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe(
      "`freshness` must be an ISO 8601 duration (PnDTnHnMnS)",
    );
  });

  it("renders the fixture passport as the UNTP triad with the source stated", async () => {
    const response = await call("/untp/product/" + encodeURIComponent(FIXTURE_ID));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-as-of")).toBeTruthy();
    const body = (await response.json()) as {
      passport?: Record<string, unknown>;
      rendering?: { source?: string; profile?: string };
    };
    const text = JSON.stringify(body);
    expect(text).toContain("DigitalProductPassport");
    expect(body.rendering?.source).toBe("fixture");
    expect(body.rendering?.profile).toBe("urn:unidpp:profile:render:untp");
  });

  it("refuses the method axum refuses", async () => {
    const response = await call("/untp/product/x", {}, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET,HEAD");
  });

  it("imports a UNTP triad with a deterministic identity and matches on re-import", async () => {
    const first = await call("/untp/ingest", {}, { method: "POST", body: untpTriad() });
    expect(first.status).toBe(201);
    const imported = (await first.json()) as {
      status?: string;
      passport_id?: string;
      identity?: string;
      granularity?: string;
      profiles?: { id?: string; version?: string }[];
      receipt?: { commitment?: string; source?: { regime?: string } };
    };
    expect(imported.status).toBe("imported");
    expect(imported.passport_id).toMatch(/^urn:unidpp:passport:untp-[0-9a-f]{12}$/);
    expect(imported.identity).toBe("01+04012345123456");
    expect(imported.granularity).toBe("model");
    expect(imported.profiles?.[0]?.id).toBe("urn:unidpp:profile:eu-espr-electronics");
    expect(imported.receipt?.commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(imported.receipt?.source?.regime).toBe("untp");

    const second = await call("/untp/ingest", {}, { method: "POST", body: untpTriad() });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { status?: string }).status).toBe("matched");

    // The imported passport resolves on the render direction (the
    // ingested store's entries answer the same keys the fixture
    // source answers).
    const rendered = await call("/untp/product/" + encodeURIComponent(imported.passport_id ?? ""));
    expect(rendered.status).toBe(200);
    const triad = (await rendered.json()) as { passport?: Record<string, unknown> };
    expect(JSON.stringify(triad)).toContain("04012345123456");
  });

  it("degrades explicitly when the identifier scheme has no C8 mapping", async () => {
    const response = await call(
      "/untp/ingest",
      {},
      {
        method: "POST",
        body: JSON.stringify({
          passport: {
            productIdentifiers: [
              { scheme: "https://example.org/unknown/", value: "X" },
            ],
          },
        }),
      },
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { status?: string; reason?: string };
    expect(body.status).toBe("degraded");
    expect(body.reason).toContain("no C8 mapping");
    expect(body.reason).toContain("nothing is minted under a guessed scheme");
  });

  it("refuses a body with no passport VC", async () => {
    const response = await call("/untp/ingest", {}, { method: "POST", body: '{"x":1}' });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { reason?: string };
    expect(body.reason).toContain("no UNTP passport VC found");
  });
});

describe("the report channel", () => {
  it("receipts a report with the contact withheld", async () => {
    const response = await call(
      "/feedback",
      {},
      {
        method: "POST",
        body: JSON.stringify({
          identifier: "urn:unidpp:passport:report-1",
          category: "goods-mismatch",
          contact: "reporter@example.org",
          details: "the rendered product is not the product scanned",
        }),
      },
    );
    expect(response.status).toBe(201);
    const receipt = (await response.json()) as {
      seq?: number;
      contact?: string;
      category?: string;
    };
    expect(receipt.seq).toBe(1);
    expect(receipt.contact).toBe("withheld");
    expect(receipt.category).toBe("goods-mismatch");

    const citation = await call("/feedback/1");
    expect(citation.status).toBe(200);
    expect(((await citation.json()) as { contact?: string }).contact).toBe("withheld");
  });

  it("states the validation refusals in the native order", async () => {
    const noIdentifier = await call(
      "/feedback",
      {},
      { method: "POST", body: JSON.stringify({ details: "x" }) },
    );
    expect(noIdentifier.status).toBe(400);
    expect(((await noIdentifier.json()) as { error: string }).error).toBe(
      "`identifier` is required — a report is about something",
    );
    const noDetails = await call(
      "/feedback",
      {},
      { method: "POST", body: JSON.stringify({ identifier: "x" }) },
    );
    expect(noDetails.status).toBe(400);
    expect(((await noDetails.json()) as { error: string }).error).toBe(
      "`details` is required — a report states what did not match",
    );
    const malformed = await call("/feedback", {}, { method: "POST", body: "not json" });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { error: string }).error).toBe(
      "invalid JSON body: expected ident at line 1 column 2",
    );
  });

  it("lists for the admin and refuses a wrong token", async () => {
    const listed = await call("/admin/feedback?limit=10");
    expect(listed.status).toBe(200);
    const listing = (await listed.json()) as { total?: number; records?: unknown[] };
    expect(listing.total).toBeGreaterThanOrEqual(1);
    expect(listing.records?.length).toBe(listing.total);

    const guarded = await call(
      "/admin/feedback",
      { UNIDPP_GATEWAY_ADMIN_TOKEN: "sekrit" },
    );
    expect(guarded.status).toBe(401);
    expect(((await guarded.json()) as { error: string }).error).toBe("unauthorized");
  });

  it("answers the citation miss with the frozen bytes", async () => {
    const missing = await call("/feedback/999");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('{"error":"not found"}');
  });
});

describe("the scan-token gate", () => {
  it("states the open gate when no policy is configured", async () => {
    const response = await call(
      "/scan-tokens",
      {},
      { method: "POST", body: JSON.stringify({ source: "mobileqr" }) },
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error?: string; gate?: string };
    expect(body.gate).toBe("open");
    expect(body.error).toContain("no scan policy is configured");
  });

  it("issues under a policy, throttles the same source, and demands the token", async () => {
    const policy: Env = {
      UNIDPP_GATEWAY_SCAN_TTL_SECS: "60",
      UNIDPP_GATEWAY_SCAN_LIMIT_PER_MIN: "1",
    };
    const first = await call(
      "/scan-tokens",
      policy,
      { method: "POST", body: JSON.stringify({ source: "qa-rig" }) },
    );
    expect(first.status).toBe(201);
    const issued = (await first.json()) as { token?: string; ttl_secs?: number };
    expect(issued.ttl_secs).toBe(60);
    expect(issued.token).toMatch(/^scan-/);

    const throttled = await call(
      "/scan-tokens",
      policy,
      { method: "POST", body: JSON.stringify({ source: "qa-rig" }) },
    );
    expect(throttled.status).toBe(429);

    const other = await call(
      "/scan-tokens",
      policy,
      { method: "POST", body: JSON.stringify({ source: "other-rig" }) },
    );
    expect(other.status).toBe(201);

    const refused = await call(
      "/untp/product/" + encodeURIComponent(FIXTURE_ID),
      policy,
    );
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "scan token required: this gateway enforces a 60 s scan policy — obtain one from POST /scan-tokens",
    );

    const unknown = await call(
      "/untp/product/" + encodeURIComponent(FIXTURE_ID),
      policy,
      { headers: { "x-unidpp-scan": "scan-not-a-token" } },
    );
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as { error: string }).error).toBe("unknown scan token");

    const admitted = await call(
      "/untp/product/" + encodeURIComponent(FIXTURE_ID),
      policy,
      { headers: { "x-unidpp-scan": issued.token ?? "" } },
    );
    expect(admitted.status).toBe(200);
  });
});
