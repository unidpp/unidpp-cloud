import contractYaml from "../../../openapi/render.yaml";
import { discovery, render } from "./render";
import type { RenderEnv } from "./render";

export interface Env extends RenderEnv {
  UNIDPP_GATEWAY_BIND?: string;
}

const contract =
  typeof contractYaml === "string" ? contractYaml : String(contractYaml);

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });

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
    if (path === "/") {
      return discovery(request, env);
    }
    return render(path, request, env);
  },
};
