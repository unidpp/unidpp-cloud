import contractYaml from "../../../openapi/hub.yaml";
import contractJsonRaw from "../../../openapi/hub.json";
import { errorResponse, jsonResponse } from "../../runtime/respond";
import { paths, routedPaths } from "./routes";
import { encodeHex } from "./hex";
import { seededEd25519, type Ed25519Key } from "./signing";
import { relay, relayVerify } from "./relay";

export interface Env {
  UNIDPP_HUB_ID?: string;
  UNIDPP_HUB_SEED?: string;
  UNIDPP_HUB_BIND?: string;
}

// The default seed of the Rust reference (seeded-dev mode).
const DEFAULT_SEED = "unidpp-hub";

const contractJson = JSON.stringify(contractJsonRaw);

// Only the derived key memo persists across requests — no relay state
// exists anywhere (statelessness is structural).
let memo: { seed: string; key: Ed25519Key } | undefined;

function keyFor(seed: string): Ed25519Key {
  if (!memo || memo.seed !== seed) {
    memo = { seed, key: seededEd25519(new TextEncoder().encode(seed)) };
  }
  return memo.key;
}

function discoveryDocument(hubId: string): Record<string, unknown> {
  return {
    service: "unidpp-hub",
    description:
      "UniDPP translation hub: a stateless signed relay between willing pairs divided by protocols (the SI-3 hub contract)",
    hub_id: hubId,
    endpoints: {
      health: "GET /healthz",
      keyring: "GET /keyring — the hub's public key (relay signatures verify under it)",
      relay:
        "POST /relay {from, to, data_class, evidence_hex, declarations: [..]} — both sides' published declarations ride the request; willingness is checked both ways, the forwarded bytes are signed in the HUB-RELAY domain, nothing is retained",
      relay_verify: "POST /relay/verify {evidence_hex, relay: {..}} — verify a relay under this hub's key",
    },
    contract: [
      "stateless: no storage, no journals, no posture state — the caller carries the declarations",
      "willingness both ways: a scheme that declines interop is never brokered around (the WILL gap is not the hub's to bridge)",
      "signed: every relay is signed in the HUB-RELAY domain over the forwarded bytes plus the relay metadata",
      "no master: a pair that speaks directly has no need of the hub; no message of the protocol names one",
    ],
  };
}

async function readJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const contentType = request.headers.get("content-type");
  if (!contentType || !contentType.toLowerCase().includes("application/json")) {
    return { ok: false, response: errorResponse(415, "expected `application/json`") };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: errorResponse(400, "unreadable request body") };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: errorResponse(400, "invalid JSON syntax") };
  }
}

function stringField(v: Record<string, unknown>, key: string): string | undefined {
  const value = v[key];
  return typeof value === "string" ? value : undefined;
}

function notFound(): Response {
  return errorResponse(404, "no such path");
}

function methodNotAllowed(): Response {
  return errorResponse(405, "method not allowed");
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const hubId = env.UNIDPP_HUB_ID?.trim() || "unidpp-hub-1";
    const seed = env.UNIDPP_HUB_SEED || DEFAULT_SEED;
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === paths.contractYaml && request.method === "GET") {
      return new Response(contractYaml, {
        status: 200,
        headers: { "content-type": "application/yaml" },
      });
    }
    if (path === paths.contractJson && request.method === "GET") {
      return new Response(contractJson, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    switch (path) {
      case paths.root: {
        if (request.method !== "GET") return methodNotAllowed();
        return jsonResponse(discoveryDocument(hubId));
      }
      case paths.healthz: {
        if (request.method !== "GET") return methodNotAllowed();
        return jsonResponse({ status: "ok" });
      }
      case paths.keyring: {
        if (request.method !== "GET") return methodNotAllowed();
        const key = keyFor(seed);
        return jsonResponse({
          mode: env.UNIDPP_HUB_SEED ? "declared-seed" : "seeded-dev",
          roles: {
            relay: {
              suite: "ed25519",
              public_hex: encodeHex(key.publicKeyBytes),
            },
          },
        });
      }
      case paths.relay: {
        if (request.method !== "POST") return methodNotAllowed();
        const body = await readJsonBody(request);
        if (!body.ok) return body.response;
        const v = body.value;
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          return errorResponse(422, "relay: expected an object");
        }
        const record = v as Record<string, unknown>;
        const from = stringField(record, "from");
        const to = stringField(record, "to");
        const dataClass = stringField(record, "data_class");
        const evidenceHex = stringField(record, "evidence_hex");
        if (from === undefined || to === undefined || dataClass === undefined || evidenceHex === undefined) {
          return errorResponse(422, "relay: expected from, to, data_class and evidence_hex strings");
        }
        if (!("declarations" in record)) {
          return errorResponse(422, "relay: missing declarations");
        }
        const outcome = relay(
          { from, to, data_class: dataClass, evidence_hex: evidenceHex, declarations: record["declarations"] },
          hubId,
          keyFor(seed),
        );
        return jsonResponse(outcome.body, outcome.status);
      }
      case paths.relayVerify: {
        if (request.method !== "POST") return methodNotAllowed();
        const body = await readJsonBody(request);
        if (!body.ok) return body.response;
        const v = body.value;
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          return errorResponse(422, "relay verify: expected an object");
        }
        const record = v as Record<string, unknown>;
        const evidenceHex = stringField(record, "evidence_hex");
        const relayValue = record["relay"];
        if (evidenceHex === undefined || typeof relayValue !== "object" || relayValue === null) {
          return errorResponse(422, "relay verify: expected evidence_hex and relay");
        }
        const relayRecord = relayValue as Record<string, unknown>;
        const hubIdField = stringField(relayRecord, "hub_id");
        const from = stringField(relayRecord, "from");
        const to = stringField(relayRecord, "to");
        const dataClass = stringField(relayRecord, "data_class");
        if (hubIdField === undefined || from === undefined || to === undefined || dataClass === undefined) {
          return errorResponse(422, "relay verify: expected hub_id, from, to and data_class strings");
        }
        if (!("evidence_digest" in relayRecord) || !("signature" in relayRecord)) {
          return errorResponse(422, "relay verify: missing evidence_digest or signature");
        }
        const outcome = relayVerify(
          {
            evidence_hex: evidenceHex,
            relay: {
              hub_id: hubIdField,
              from,
              to,
              data_class: dataClass,
              evidence_digest: relayRecord["evidence_digest"],
              signature: relayRecord["signature"],
            },
          },
          keyFor(seed),
        );
        return jsonResponse(outcome.body, outcome.status);
      }
      default:
        return routedPaths.includes(path) ? methodNotAllowed() : notFound();
    }
  },
};
