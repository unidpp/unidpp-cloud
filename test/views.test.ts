import { describe, expect, it } from "vitest";
import worker from "../src/workers/views/index";
import contractYaml from "../openapi/views.yaml";
import type { Env } from "../src/workers/views/index";
import type { ViewsEnv } from "../src/workers/views/view";

// The projector worker's gates (263, increment two): the golden
// contract served byte-identically, the fixture path computing the
// projection through the boundary with no estate bound (the built-in
// lens and demo passport, the source stated), the refusals stating
// themselves, and the bound-estate path riding the service binding.
const contract =
  typeof contractYaml === "string" ? contractYaml : String(contractYaml);

const call = (
  path: string,
  env: Env = {},
  init?: RequestInit,
): Promise<Response> =>
  worker.fetch(
    new Request("https://views.unidpp.org" + path, init),
    env,
    {} as ExecutionContext,
  );

// A stub estate binding: the issuer surface answers one registered
// passport; the registry answers nothing (the fixture lens serves).
const stubEstate = (passport: Record<string, unknown>): ViewsEnv["ESTATE"] => {
  return {
    fetch: async (input: Request | string) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.pathname === "/issuer/passports/demo-passport") {
        return new Response(JSON.stringify({ ...passport, audit_seq: 7 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response('{"error":"not found"}', { status: 404 });
    },
  };
};

describe("the projector worker's contract", () => {
  it("serves the golden contract byte-identically", async () => {
    const response = await call("/openapi.yaml");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(contract);
  });

  it("answers the liveness probe and the discovery document", async () => {
    expect((await call("/healthz")).status).toBe(200);
    const discovery = (await (await call("/")).json()) as Record<string, unknown>;
    expect(discovery.service).toBe("unidpp-projector");
    const endpoints = discovery.endpoints as Record<string, string>;
    expect(endpoints.view).toContain("GET /view");
    expect(endpoints.render).toContain("GET /render");
  });

  it("refuses the missing parameters with stated reasons", async () => {
    const noPassport = await call("/view?profile=x");
    expect(noPassport.status).toBe(400);
    expect(((await noPassport.json()) as { error: string }).error).toBe(
      "`passport` query parameter is required",
    );
    const noProfile = await call("/view?passport=x");
    expect(noProfile.status).toBe(400);
    const noLang = await call("/render?passport=x&profile=y");
    expect(noLang.status).toBe(400);
  });

  it("projects the fixture lens and demo passport with the source stated", async () => {
    const response = await call(
      "/view?passport=urn:iso:std:iso-iec:15459:unidpp:passport:84120099012345&profile=urn:unidpp:profile:eu-espr-electronics&actor=views-test",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      passport?: { source?: string };
      as_of?: string;
    };
    expect(body.passport?.source).toBe("fixtures");
    expect(body.as_of).toBeTruthy();
  });

  it("rides the estate binding when a passport is registered there", async () => {
    const passport = {
      schema: "unidpp/passport@1",
      passport_id: "demo-passport",
      product_id: "local:demo:estate-1",
      log: { subject: "demo-passport", sealed: [] },
      eo_id: "urn:eo:maker",
      resolver_uri: "https://resolve.unidpp.org/r/demo",
      validity: { from: "2026-01-01T00:00:00Z", to: null },
      created_at: "2026-01-01T00:00:00Z",
      capability: "silent",
    };
    const env: Env = { ESTATE: stubEstate(passport) };
    const response = await call(
      "/view?passport=demo-passport&profile=urn:unidpp:profile:eu-espr-electronics&actor=views-test",
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { passport?: { id?: string; source?: string } };
    expect(body.passport?.id).toBe("demo-passport");
    expect(body.passport?.source).toBe("fixtures");
  });
});

describe("the router fallbacks", () => {
  it("answers unknown paths with the axum default: an empty 404", async () => {
    const response = await call("/nonexistent");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("answers wrong methods with the axum method fallback", async () => {
    const response = await call("/view", {}, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET,HEAD");
    expect(await response.text()).toBe("");
  });
});
