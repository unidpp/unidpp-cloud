import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";
import { encodeHex } from "./hex";

const KEY_SEED_LABEL = new TextEncoder().encode("UNIDPP-SIGNATIF/KEY-SEED");
export const HUB_RELAY_TAG = "UNIDPP-SIGNATIF/HUB-RELAY";

// The suite's content code byte (signatif Suite::code, Ed25519 = 6).
const ED25519_SUITE_CODE = 6;
const ED25519_SIGNATURE_LEN = 64;
// A fixed PKCS#8 DER template whose only variable is the 32-byte seed:
// SEQ { INTEGER 1, SEQ { OID 1.3.101.112 }, OCTET STRING (32) }.
const ED25519_PKCS8_PREFIX = Uint8Array.of(
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
);
const ED25519_SPKI_PREFIX_LEN = 12;

export function concat(...parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function sha256(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(createHash("sha256").update(concat(...parts)).digest());
}

export interface Ed25519Key {
  secretKey: KeyObject;
  publicKey: KeyObject;
  publicKeyBytes: Uint8Array;
  keyId: string;
}

// signatif KeyPair::seeded(Ed25519): scalar = sha256("UNIDPP-SIGNATIF/KEY-SEED" || seed),
// the scalar IS the RFC 8032 seed, so the key and every signature are byte-identical
// to the Rust implementation.
export function seededEd25519(seed: Uint8Array): Ed25519Key {
  const scalar = sha256(KEY_SEED_LABEL, seed);
  const secretKey = createPrivateKey({
    key: Buffer.from(concat(ED25519_PKCS8_PREFIX, scalar)),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(secretKey);
  const spki = new Uint8Array(publicKey.export({ format: "der", type: "spki" }) as Uint8Array);
  const publicKeyBytes = spki.subarray(ED25519_SPKI_PREFIX_LEN);
  const keyId =
    "k-" + encodeHex(sha256(Uint8Array.of(ED25519_SUITE_CODE), publicKeyBytes)).slice(0, 16);
  return { secretKey, publicKey, publicKeyBytes, keyId };
}

export function domainFramed(tag: string, payload: Uint8Array): Uint8Array {
  return concat(new TextEncoder().encode(tag), Uint8Array.of(0), payload);
}

export function signEd25519(key: Ed25519Key, payload: Uint8Array): Uint8Array {
  return new Uint8Array(nodeSign(null, payload, key.secretKey));
}

export function verifyEd25519(key: Ed25519Key, payload: Uint8Array, signature: Uint8Array): boolean {
  try {
    return nodeVerify(null, payload, key.publicKey, signature);
  } catch {
    return false;
  }
}

export { ED25519_SIGNATURE_LEN };
