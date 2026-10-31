import {
  domainFramed,
  ED25519_SIGNATURE_LEN,
  HUB_RELAY_TAG,
  sha256,
  signEd25519,
  verifyEd25519,
  type Ed25519Key,
} from "./signing";
import { decodeHex, encodeHex, HexError } from "./hex";
import {
  parseDeclarations,
  permits,
  ShapeError,
  type SignatureSlotWire,
} from "./declarations";

export interface RelayInput {
  from: string;
  to: string;
  data_class: string;
  evidence_hex: string;
  declarations: unknown;
}

export interface RelayedEvidence {
  hub_id: string;
  from: string;
  to: string;
  data_class: string;
  evidence_digest: number[];
  signature: SignatureSlotWire;
}

export type RelayOutcome =
  | { status: 200; body: { relay: RelayedEvidence; evidence_hex: string } }
  | { status: 400; body: { error: string } }
  | { status: 422; body: { error: string; refused?: boolean } };

function cryptoError(message: string): string {
  return `cryptographic error: ${message}`;
}

// signatif Hub::relay_payload — Annex B canonical framing:
// length-prefixed (u32 LE) hub id, evidence digest, endpoints and class.
export function relayPayload(
  hubId: string,
  evidence: Uint8Array,
  from: string,
  to: string,
  dataClass: string,
): Uint8Array {
  const encoder = new TextEncoder();
  const fields = [
    encoder.encode(hubId),
    sha256(evidence),
    encoder.encode(from),
    encoder.encode(to),
    encoder.encode(dataClass),
  ];
  const out = new Uint8Array(fields.reduce((n, f) => n + 4 + f.length, 0));
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const field of fields) {
    view.setUint32(offset, field.length, true);
    offset += 4;
    out.set(field, offset);
    offset += field.length;
  }
  return out;
}

export function relay(input: RelayInput, hubId: string, key: Ed25519Key): RelayOutcome {
  let declarations;
  try {
    declarations = parseDeclarations(input.declarations);
  } catch (e) {
    if (e instanceof ShapeError) {
      return { status: 422, body: { error: e.message } };
    }
    throw e;
  }
  let evidence: Uint8Array;
  try {
    evidence = decodeHex(input.evidence_hex.trim());
  } catch (e) {
    if (e instanceof HexError) {
      return { status: 400, body: { error: `\`evidence_hex\`: ${e.message}` } };
    }
    throw e;
  }
  for (const [declarer, counterpart] of [
    [input.from, input.to],
    [input.to, input.from],
  ] as const) {
    const permission = permits(declarations, declarer, counterpart, input.data_class, "hub");
    if (permission.kind === "refused") {
      return {
        status: 422,
        body: {
          error: cryptoError(
            `hub \`${hubId}\` refuses the relay: ${permission.reason}`,
          ),
          refused: true,
        },
      };
    }
    if (permission.kind === "no-declaration") {
      return {
        status: 422,
        body: {
          error: cryptoError(
            `hub \`${hubId}\` refuses the relay: \`${declarer}\` publishes no interop declaration covering class \`${input.data_class}\` toward \`${counterpart}\``,
          ),
          refused: true,
        },
      };
    }
  }
  const digest = sha256(evidence);
  const payload = domainFramed(
    HUB_RELAY_TAG,
    relayPayload(hubId, evidence, input.from, input.to, input.data_class),
  );
  const signature = signEd25519(key, payload);
  return {
    status: 200,
    body: {
      relay: {
        hub_id: hubId,
        from: input.from,
        to: input.to,
        data_class: input.data_class,
        evidence_digest: Array.from(digest),
        signature: {
          suite: "ed25519",
          key_id: key.keyId,
          signature: Array.from(signature),
        },
      },
      evidence_hex: input.evidence_hex.trim(),
    },
  };
}

export interface RelayVerifyInput {
  evidence_hex: string;
  relay: {
    hub_id: string;
    from: string;
    to: string;
    data_class: string;
    evidence_digest: unknown;
    signature: unknown;
  };
}

export type RelayVerifyOutcome =
  | {
      status: 200;
      body: { verified: true; evidence_digest: string } | { verified: false; error: string };
    }
  | { status: 400; body: { error: string } }
  | { status: 422; body: { error: string } };

const SUITE_TOKENS: ReadonlySet<string> = new Set([
  "ed25519",
  "ecdsa-p256",
  "sm2",
  "ml-dsa-44",
  "ml-dsa-65",
  "ml-dsa-87",
  "slh-dsa-128s",
  "slh-dsa-192s",
]);

function parseSuite(token: string): string {
  const normalized = token.toLowerCase();
  if (!SUITE_TOKENS.has(normalized)) {
    throw new ShapeError(`signature.suite: unknown variant \`${token}\``);
  }
  return normalized;
}

function deferral(suite: string): string | null {
  if (suite === "sm2") {
    return "SM2 computation requires a GM/T 0003 binding crate; SIGNATIF carries the core's framing (64-byte r||s slots) and refuses to fake verification";
  }
  if (suite === "ml-dsa-44" || suite === "ml-dsa-65" || suite === "ml-dsa-87") {
    return "ML-DSA (FIPS 204) computation requires a PQ binding crate; SIGNATIF carries the core's framing and budget math only";
  }
  return null;
}

function unsupported(suite: string): string | null {
  if (suite === "slh-dsa-128s" || suite === "slh-dsa-192s") {
    return "SLH-DSA (FIPS 205) computation requires the `slh-dsa` crate feature; enable it to activate the (currently stubbed) SLH-DSA path";
  }
  return null;
}

function digestAt(value: unknown): Uint8Array {
  if (!Array.isArray(value) || value.length !== 32 || !value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new ShapeError("relay.evidence_digest: expected 32 bytes");
  }
  return Uint8Array.from(value as number[]);
}

function signatureAt(value: unknown): { suite: string; keyId: string; bytes: Uint8Array | null } {
  const slot = (value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined) as Record<string, unknown> | undefined;
  if (!slot) throw new ShapeError("relay.signature: expected an object");
  const suite = parseSuite(String(slot["suite"] ?? ""));
  const keyId = slot["key_id"];
  if (typeof keyId !== "string") throw new ShapeError("relay.signature.key_id: expected a string");
  const raw = slot["signature"];
  if (raw === null) return { suite, keyId, bytes: null };
  if (!Array.isArray(raw) || !raw.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new ShapeError("relay.signature.signature: expected a byte array or null");
  }
  return { suite, keyId, bytes: Uint8Array.from(raw as number[]) };
}

export function relayVerify(input: RelayVerifyInput, key: Ed25519Key): RelayVerifyOutcome {
  // The Rust Json extractor deserializes the whole request before the
  // handler runs, so shape errors answer before the hex check.
  let slot: { suite: string; keyId: string; bytes: Uint8Array | null };
  let digest: Uint8Array;
  try {
    digest = digestAt(input.relay.evidence_digest);
    slot = signatureAt(input.relay.signature);
  } catch (e) {
    if (e instanceof ShapeError) {
      return { status: 422, body: { error: e.message } };
    }
    throw e;
  }
  let evidence: Uint8Array;
  try {
    evidence = decodeHex(input.evidence_hex.trim());
  } catch (e) {
    if (e instanceof HexError) {
      return { status: 400, body: { error: `\`evidence_hex\`: ${e.message}` } };
    }
    throw e;
  }
  const payload = domainFramed(
    HUB_RELAY_TAG,
    relayPayload(
      input.relay.hub_id,
      evidence,
      input.relay.from,
      input.relay.to,
      input.relay.data_class,
    ),
  );
  const invalid = (message: string): RelayVerifyOutcome => ({
    status: 200,
    body: { verified: false, error: cryptoError(message) },
  });
  const unsupportedDetail = unsupported(slot.suite);
  if (unsupportedDetail) return invalid(`suite \`${slot.suite}\` is unsupported here: ${unsupportedDetail}`);
  const deferralDetail = deferral(slot.suite);
  if (deferralDetail) return invalid(`suite \`${slot.suite}\` is framing-only here: ${deferralDetail}`);
  if (slot.suite !== "ed25519") {
    return invalid(`slot suite \`${slot.suite}\` does not match key suite \`ed25519\``);
  }
  if (!slot.bytes) return invalid("slot is framed-only (nothing to verify)");
  if (slot.bytes.length !== ED25519_SIGNATURE_LEN) {
    return invalid(
      `signature length ${slot.bytes.length} does not match the ed25519 framing budget ${ED25519_SIGNATURE_LEN}`,
    );
  }
  if (!verifyEd25519(key, payload, slot.bytes)) {
    return invalid("Ed25519 signature invalid");
  }
  return { status: 200, body: { verified: true, evidence_digest: encodeHex(digest) } };
}
