// The boundary's export surface (the union worker's wasm.ts types,
// trimmed to the exports the views worker calls).
export interface CoreExports {
  unidpp_alloc(len: number): number;
  unidpp_free(ptr: number, len: number): void;
  unidpp_sha256(ptr: number, len: number, out: number): void;
  unidpp_head_public(seed: number, out: number): number;
  unidpp_head_key_id(seed: number, out: number): number;
  unidpp_note_take(out: number): number;
  unidpp_view_project(
    passport: number,
    passportLen: number,
    lens: number,
    lensLen: number,
    atSecs: bigint,
    actor: number,
    actorLen: number,
  ): number;
  unidpp_fixture_lens(profile: number, profileLen: number): number;
  unidpp_fixture_passport(): number;
  memory: { buffer: ArrayBuffer };
}
