# unidpp-cloud

The UniDPP Cloudflare deployment: every service of the estate as a
Worker, on the routes unidpp.org already serves. The repo exists
because production cannot live on a workstation: on 2026-09-24 the
pilot's cloudflared connectors died on the host and unidpp.org stayed
dark for five weeks while the nightly CI named the drift. The
owner's direction this series: everything deploys on Cloudflare, no
origin machines, no Containers — every Worker fits the Workers
runtime (see `TODO.impl/262-cloudflare-production.md`).

The repo follows the family's interface doctrine. Each Worker serves
its committed golden `openapi.yaml` byte-identically (the same
contract its Rust reference serves), routes by a path-constant table,
and is gated by the same checks: golden equality, both path-set
directions, discovery-subset, and the 405 probe — here as vitest
tests against the real workerd runtime. Behavior is pinned by
vectors produced by the Rust implementation (the 234 doctrine): the
hub's fixtures carry a Rust-signed relay, the refusals' exact bytes,
and the seeded-key public value, and the Worker must reproduce every
byte.

## State

| Worker | Route | Status |
|---|---|---|
| hub | `hub.unidpp.org` | implemented — the stateless signed relay (SI-3), WebCrypto/node Ed25519, no WASM needed |
| identity, resolver | `identity.unidpp.org`, `resolve.unidpp.org` | live (moving here from unidpp-edge-services) |
| projector, gateway, archive, console, log, trust, registry, issuer | — | series 263–268 |

## Layout

```text
src/runtime/          the shared surface every Worker serves (responses with the as-of stamp; contract helpers)
src/workers/hub/      the hub Worker: routes, declarations, signing, relay
openapi/hub.yaml      the golden contract (byte-identical with unidpp-hub's)
openapi/hub.json      the /openapi.json twin (the reference serves it without x-unidpp-env-keys)
wrangler/             one committed wrangler config per Worker (goldens; unidpp-config render-wrangler generates them)
test/fixtures/        Rust-produced vectors: declarations, signed relays, refusals, verifications
```

## Commands

```sh
npm ci
npm run typecheck
npm test                       # vitest in workerd; the vector pins live here
npx wrangler deploy --config wrangler/hub.jsonc
```

## Environment

| Key | Meaning |
|---|---|
| `UNIDPP_HUB_ID` | the hub's trust-graph node id (wrangler var) |
| `UNIDPP_HUB_SEED` | the relay signing seed (a Secret — never committed); unset = seeded-dev mode with the documented default |
| `UNIDPP_HUB_BIND` | the reference deployment's bind knob; carried in the contract for byte-identity, without Workers meaning |

The deploy workflow runs on main; it needs the `CLOUDFLARE_API_TOKEN`
and (for production keys) `UNIDPP_HUB_SEED` secrets in the
`production` environment.
