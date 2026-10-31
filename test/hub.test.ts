import { describe, expect, it } from "vitest";
import worker from "../src/workers/hub/index";
import type { Env } from "../src/workers/hub/index";
import { seededEd25519 } from "../src/workers/hub/signing";
import { encodeHex } from "../src/workers/hub/hex";
import contractJson from "../openapi/hub.json";
import relayWilling from "./fixtures/relay-willing.json";
import relayDeclining from "./fixtures/relay-declining.json";
import relayNoDeclaration from "./fixtures/relay-nodeclaration.json";
import verifyGood from "./fixtures/verify-good.json";
import verifyTampered from "./fixtures/verify-tampered.json";

// The exact environment the Rust vector hub ran under (TODO 262):
// UNIDPP_HUB_ID=vector-hub UNIDPP_HUB_SEED=vector-seed-262.
const ENV: Env = { UNIDPP_HUB_ID: "vector-hub", UNIDPP_HUB_SEED: "vector-seed-262" };

function call(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request("https://hub.unidpp.org" + path, init), ENV, {} as ExecutionContext);
}

function jsonPost(path: string, body: unknown, contentType = "application/json"): Promise<Response> {
  return call(path, {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });
}

describe("the Rust vector pins", () => {
  it("derives the same seeded public key as the Rust hub", () => {
    const key = seededEd25519(new TextEncoder().encode("vector-seed-262"));
    expect(encodeHex(key.publicKeyBytes)).toBe(
      "a905097238e1f127e4dea15826b85de3d4c01a303d2aab02355f39615757f002",
    );
    expect(key.keyId).toBe((relayWilling as any).response.relay.signature.key_id);
  });

  it("reproduces the Rust-signed relay byte-identically", async () => {
    const response = await jsonPost("/relay", (relayWilling as any).request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual((relayWilling as any).response);
  });

  it("verifies the Rust relay as good", async () => {
    const response = await jsonPost("/relay/verify", (verifyGood as any).request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual((verifyGood as any).response);
  });

  it("refuses tampered evidence under a valid relay signature", async () => {
    const response = await jsonPost("/relay/verify", (verifyTampered as any).request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual((verifyTampered as any).response);
  });

  it("refuses the WILL gap with the Rust refusal bytes", async () => {
    const response = await jsonPost("/relay", (relayDeclining as any).request);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual((relayDeclining as any).response);
  });

  it("refuses a missing declaration with the Rust refusal bytes", async () => {
    const response = await jsonPost("/relay", (relayNoDeclaration as any).request);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual((relayNoDeclaration as any).response);
  });
});

describe("the willingness gate", () => {
  const declaration = (transports: string[], level = "l3") => ({
    declarer: "a-scheme",
    counterpart: "b-scheme",
    version: 1,
    postures: [
      {
        data_class: "c1",
        level,
        recognition: "bilateral-anchors",
        transports,
        escalation: null,
        reciprocity: null,
      },
    ],
    valid_from: "2030-01-01T00:00:00Z",
    valid_to: null,
    signature: { suite: "ed25519", key_id: "k-test", signature: null },
  });

  it("states the transport gap when hub is not offered", async () => {
    const response = await jsonPost("/relay", {
      from: "a-scheme",
      to: "b-scheme",
      data_class: "c1",
      evidence_hex: "00",
      declarations: [declaration(["document"])],
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error:
        "cryptographic error: hub `vector-hub` refuses the relay: `a-scheme` offers [Document] for class `c1` toward `b-scheme`, not `hub`",
      refused: true,
    });
  });

  it("states the WILL gap when the declarer itself declines", async () => {
    const response = await jsonPost("/relay", {
      from: "a-scheme",
      to: "b-scheme",
      data_class: "c1",
      evidence_hex: "00",
      declarations: [declaration(["hub"], "l0")],
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string; refused?: boolean };
    expect(body.refused).toBe(true);
    expect(body.error).toBe(
      "cryptographic error: hub `vector-hub` refuses the relay: `a-scheme` declares L0 for class `c1` toward `b-scheme` — the WILL gap, never brokered around",
    );
  });
});

describe("the input surface", () => {
  it("answers 400 for non-hex evidence", async () => {
    const response = await jsonPost("/relay", {
      from: "a", to: "b", data_class: "c", evidence_hex: "zz", declarations: [],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "`evidence_hex`: not hex" });
  });

  it("answers 400 for odd-length evidence", async () => {
    const response = await jsonPost("/relay", {
      from: "a", to: "b", data_class: "c", evidence_hex: "abc", declarations: [],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "`evidence_hex`: not hex (odd length)" });
  });

  it("answers 415 without a JSON content type", async () => {
    const response = await jsonPost("/relay", {}, "text/plain");
    expect(response.status).toBe(415);
  });

  it("answers 400 for invalid JSON syntax", async () => {
    const response = await call("/relay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });

  it("answers 422 for a body that does not deserialize", async () => {
    const response = await jsonPost("/relay/verify", {
      evidence_hex: "00",
      relay: { hub_id: "h", from: "a", to: "b", data_class: "c", evidence_digest: [1, 2, 3], signature: null },
    });
    expect(response.status).toBe(422);
  });
});

describe("statelessness", () => {
  it("relays identically twice and retains nothing", async () => {
    const first = await jsonPost("/relay", (relayWilling as any).request);
    const second = await jsonPost("/relay", (relayWilling as any).request);
    expect(await first.json()).toEqual(await second.json());
  });
});

describe("tamper detection", () => {
  it("rejects a flipped signature byte", async () => {
    const relay = structuredClone((verifyGood as any).request.relay);
    relay.signature.signature[63] ^= 0x01;
    const response = await jsonPost("/relay/verify", { evidence_hex: (verifyGood as any).request.evidence_hex, relay });
    const body = (await response.json()) as { verified: boolean; error: string };
    expect(body.verified).toBe(false);
    expect(body.error).toBe("cryptographic error: Ed25519 signature invalid");
  });

  it("rejects a wrong-length signature", async () => {
    const relay = structuredClone((verifyGood as any).request.relay);
    relay.signature.signature = relay.signature.signature.slice(0, 63);
    const response = await jsonPost("/relay/verify", { evidence_hex: (verifyGood as any).request.evidence_hex, relay });
    const body = (await response.json()) as { verified: boolean; error: string };
    expect(body.verified).toBe(false);
    expect(body.error).toBe(
      "cryptographic error: signature length 63 does not match the ed25519 framing budget 64",
    );
  });

  it("states the deferral for a framing-only suite", async () => {
    const relay = structuredClone((verifyGood as any).request.relay);
    relay.signature.suite = "sm2";
    const response = await jsonPost("/relay/verify", { evidence_hex: (verifyGood as any).request.evidence_hex, relay });
    const body = (await response.json()) as { verified: boolean; error: string };
    expect(body.verified).toBe(false);
    expect(body.error).toBe(
      "cryptographic error: suite `sm2` is framing-only here: SM2 computation requires a GM/T 0003 binding crate; SIGNATIF carries the core's framing (64-byte r||s slots) and refuses to fake verification",
    );
  });
});

describe("the basic surfaces", () => {
  it("answers the liveness probe", async () => {
    const response = await call("/healthz");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-as-of")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves the keyring in declared-seed mode", async () => {
    const response = await call("/keyring");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode: "declared-seed",
      roles: {
        relay: {
          suite: "ed25519",
          public_hex: "a905097238e1f127e4dea15826b85de3d4c01a303d2aab02355f39615757f002",
        },
      },
    });
  });

  it("serves the keyring in seeded-dev mode without a declared seed", async () => {
    const response = await worker.fetch(
      new Request("https://hub.unidpp.org/keyring"),
      { UNIDPP_HUB_ID: "dev-hub" },
      {} as ExecutionContext,
    );
    const body = (await response.json()) as { mode: string };
    expect(body.mode).toBe("seeded-dev");
  });

  it("answers 404 off the contract", async () => {
    expect((await call("/nope")).status).toBe(404);
  });
});

describe("the contract gates", () => {
  const documented = contractJson.paths as Record<string, Record<string, unknown>>;

  it("serves the golden contract with the deployment keys", async () => {
    const response = await call("/openapi.yaml");
    expect(response.status).toBe(200);
    const yaml = await response.text();
    expect(yaml).toContain("title: UniDPP hub");
    expect(yaml).toContain("x-unidpp-env-keys:");
    for (const key of ["UNIDPP_HUB_BIND", "UNIDPP_HUB_ID", "UNIDPP_HUB_SEED"]) {
      expect(yaml).toContain(`- ${key}`);
    }
  });

  it("serves a JSON twin without the deployment keys", async () => {
    const response = await call("/openapi.json");
    expect(response.status).toBe(200);
    const body = (await response.json()) as typeof contractJson;
    expect(body).toEqual(contractJson);
    expect((body.info as Record<string, unknown>)["x-unidpp-env-keys"]).toBeUndefined();
  });

  it("routes every documented operation and nothing else", async () => {
    for (const [path, item] of Object.entries(documented)) {
      const methods = ["get", "post", "put", "delete", "patch"].filter((v) => item[v]);
      expect(methods.length, `${path} documents no method`).toBeGreaterThan(0);
      for (const verb of ["get", "post", "put", "delete", "patch"]) {
        const response = await call(path, {
          method: verb.toUpperCase(),
          headers: { "content-type": "application/json" },
          body: verb === "get" ? undefined : "{}",
        });
        if (methods.includes(verb)) {
          expect(response.status, `${verb} ${path}`).not.toBe(405);
        } else {
          expect(response.status, `${verb} ${path}`).toBe(405);
        }
      }
    }
  });

  it("names only contracted endpoints in the discovery document", async () => {
    const response = await call("/");
    const doc = JSON.stringify(await response.json());
    const documentedPaths = new Set(Object.keys(documented));
    for (const match of doc.matchAll(/(?:GET|POST|PUT|DELETE|PATCH) (\/[A-Za-z0-9_/-]*)/g)) {
      expect(documentedPaths.has(match[1]), `discovery names ${match[1]}`).toBe(true);
    }
  });

  it("states the contract in the discovery document", async () => {
    const response = await call("/");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.service).toBe("unidpp-hub");
    expect(body.hub_id).toBe("vector-hub");
    expect((body.contract as string[]).length).toBe(4);
  });
});
