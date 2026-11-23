import { describe, expect, it } from "vitest";
import wasmModule from "../src/core_bg.wasm";
import { createHash } from "node:crypto";
import { seededEd25519 } from "../src/workers/hub/signing";
import { encodeHex } from "../src/workers/hub/hex";

// The wasm boundary (263): the same module bytes the union worker
// carries, built from the family's core crates by this repo's own
// build. The tests instantiate it and pin the digest path and the
// seeded key derivation against the hub worker's independent pure-TS
// implementation — two derivations agreeing is the pin.
const moduleBytes = wasmModule as unknown as WebAssembly.Module;
const instance = new WebAssembly.Instance(moduleBytes, {});
const core = instance.exports as unknown as {
  unidpp_alloc(len: number): number;
  unidpp_free(ptr: number, len: number): void;
  unidpp_sha256(ptr: number, len: number, out: number): void;
  unidpp_head_public(seed: number, out: number): number;
  unidpp_head_key_id(seed: number, out: number): number;
  unidpp_note_take(out: number): number;
  unidpp_fixture_passport(): number;
  memory: { buffer: ArrayBuffer };
};

describe("the wasm boundary", () => {
  it("digests over the model crate's sha256 — the standard vector", () => {
    const input = new TextEncoder().encode("abc");
    const ptr = core.unidpp_alloc(input.length);
    new Uint8Array(core.memory.buffer, ptr, input.length).set(input);
    const out = core.unidpp_alloc(32);
    core.unidpp_sha256(ptr, input.length, out);
    const digest = [...new Uint8Array(core.memory.buffer, out, 32)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    core.unidpp_free(ptr, input.length);
    core.unidpp_free(out, 32);
    expect(digest).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("derives the same seeded key the hub worker's pure-TS derivation does", () => {
    // The boundary's key derivation takes a 32-byte material (the
    // family's callers pass label digests); the hub's derivation
    // takes any length. The cross-check feeds both the same material.
    const seed = new TextEncoder().encode("vector-seed-262");
    const digest = new Uint8Array(
      createHash("sha256").update(seed).digest(),
    );
    void seed;
    const seedPtr = core.unidpp_alloc(digest.length);
    new Uint8Array(core.memory.buffer, seedPtr, digest.length).set(digest);
    const out = core.unidpp_alloc(32);
    const rc = core.unidpp_head_public(seedPtr, out);
    const wasmPublic = [...new Uint8Array(core.memory.buffer, out, 32)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    core.unidpp_free(seedPtr, digest.length);
    core.unidpp_free(out, 32);
    expect(rc).toBe(0);
    // The hub's own derivation (pure TS, RFC 8032 by hand) — the two
    // agree, or the boundary does not carry the family's key story.
    const tsKey = seededEd25519(digest);
    expect(wasmPublic).toBe(encodeHex(tsKey.publicKeyBytes));
  });

  it("names the seeded key id through the boundary", () => {
    const seed = new TextEncoder().encode("vector-seed-262");
    const digest = new Uint8Array(
      createHash("sha256").update(seed).digest(),
    );
    const seedPtr = core.unidpp_alloc(digest.length);
    new Uint8Array(core.memory.buffer, seedPtr, digest.length).set(digest);
    const out = core.unidpp_alloc(64);
    const len = core.unidpp_head_key_id(seedPtr, out);
    core.unidpp_free(seedPtr, digest.length);
    const keyId = new TextDecoder().decode(
      new Uint8Array(core.memory.buffer, out, len).slice(),
    );
    expect(keyId).toMatch(/^k-[0-9a-f]{16}$/);
  });

  it("mints the fixture passport through the boundary", () => {
    // rc 0 = the fixture rides the note buffer.
    const rc = core.unidpp_fixture_passport();
    expect(rc).toBe(0);
    const notePtr = core.unidpp_alloc(1048576);
    const noteLen = core.unidpp_note_take(notePtr);
    const note = new TextDecoder().decode(
      new Uint8Array(core.memory.buffer, notePtr, noteLen).slice(),
    );
    core.unidpp_free(notePtr, 1048576);
    const passport = JSON.parse(note) as { schema: string; passport_id: string };
    expect(passport.schema).toBe("unidpp/passport@1");
    expect(passport.passport_id).toMatch(/^urn:iso:std:iso-iec:15459:unidpp:passport:/);
  });
});
