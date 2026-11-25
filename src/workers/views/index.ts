import contractYaml from "../../../openapi/views.yaml";
import { view } from "./view";
import type { ViewsEnv } from "./view";

export interface Env extends ViewsEnv {
  UNIDPP_PROJECTOR_BIND?: string;
}

const SERVICE = "unidpp-projector";
const VERSION = "0.1.0";

const contract =
  typeof contractYaml === "string" ? contractYaml : String(contractYaml);

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });

const asOfNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function discoveryDocument(): Record<string, unknown> {
  return {
    service: SERVICE,
    version: VERSION,
    description:
      "UniDPP projector: the presentation service — the governed twin folded as of an instant under a profile's lens, the consumer render in three wire formats, the roll-up sealing where a sealer is configured",
    endpoints: {
      health: "GET /healthz",
      view: "GET /view?passport=&profile=&actor=&at= — the view: the twin folded under the lens, the coverage honesty stated",
      render:
        "GET /render?passport=&profile=&lang=&at= — one presentation computation, three wire formats: JSON by default; Accept: text/html or text/plain (or the explicit `format` parameter, which outranks the header)",
    },
    as_of: {
      query_parameter: "at (alias: asof)",
      response_header: "x-as-of",
    },
    lens: {
      resolution:
        "the lens manifest resolves the estate's registry first, the built-in fixture otherwise, with the source stated on the view",
    },
    coverage:
      "the view states what the lens selected and what it could not — gaps carry their reason; coverage is honesty, not decoration",
  };
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }
    if (method !== "GET" && method !== "HEAD") {
      // The axum method fallback: an empty 405 naming the served
      // methods.
      return new Response(null, { status: 405, headers: { allow: "GET,HEAD" } });
    }
    if (path === "/healthz") {
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    if (path === "/openapi.yaml") {
      return new Response(contract, {
        status: 200,
        headers: { "content-type": "application/yaml" },
      });
    }
    if (path === "/" || path === "/view" || path === "/render") {
      if (path === "/") return jsonResponse(discoveryDocument());
      const response = await view(request, env);
      response.headers.set("x-as-of", asOfNow());
      return response;
    }
    // The axum router default: unknown paths answer an empty 404 —
    // the native projector mounts no custom fallback.
    return new Response(null, { status: 404 });
  },
};
