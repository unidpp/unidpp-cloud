export type HarmonizationLevel = "l0" | "l1" | "l2" | "l3" | "l4" | "l5";
export type RecognitionMode =
  | "unilateral-pinning"
  | "bilateral-anchors"
  | "club-list"
  | "master-list-mesh";
export type TransportMode = "protocol" | "document" | "hub";

// The Rust Debug names, which surface inside refusal reasons.
export const TRANSPORT_DEBUG: Record<TransportMode, string> = {
  protocol: "Protocol",
  document: "Document",
  hub: "Hub",
};

export interface ClassPosture {
  data_class: string;
  level: HarmonizationLevel;
  recognition: RecognitionMode;
  transports: TransportMode[];
  escalation: string | null;
  reciprocity: string | null;
}

export interface SignatureSlotWire {
  suite: string;
  key_id: string;
  signature: number[] | null;
}

export interface InteropDeclaration {
  declarer: string;
  counterpart: string;
  version: number;
  postures: ClassPosture[];
  valid_from: string;
  valid_to: string | null;
  signature: SignatureSlotWire;
}

export class ShapeError extends Error {}

const LEVELS: ReadonlySet<string> = new Set(["l0", "l1", "l2", "l3", "l4", "l5"]);
const RECOGNITIONS: ReadonlySet<string> = new Set([
  "unilateral-pinning",
  "bilateral-anchors",
  "club-list",
  "master-list-mesh",
]);
const TRANSPORTS: ReadonlySet<string> = new Set(["protocol", "document", "hub"]);

function objectAt(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ShapeError(`${what}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function stringAt(v: Record<string, unknown>, key: string): string {
  const value = v[key];
  if (typeof value !== "string") throw new ShapeError(`${key}: expected a string`);
  return value;
}

function optStringAt(v: Record<string, unknown>, key: string): string | null {
  const value = v[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ShapeError(`${key}: expected a string or null`);
  return value;
}

function enumAt<T extends string>(v: Record<string, unknown>, key: string, allowed: ReadonlySet<string>): T {
  const value = stringAt(v, key);
  if (!allowed.has(value)) throw new ShapeError(`${key}: unknown variant \`${value}\``);
  return value as T;
}

export function parseDeclaration(value: unknown): InteropDeclaration {
  const v = objectAt(value, "declaration");
  const postures: ClassPosture[] = [];
  const rawPostures = v["postures"];
  if (!Array.isArray(rawPostures)) throw new ShapeError("postures: expected an array");
  for (const raw of rawPostures) {
    const p = objectAt(raw, "posture");
    const transports = p["transports"];
    if (!Array.isArray(transports)) throw new ShapeError("transports: expected an array");
    postures.push({
      data_class: stringAt(p, "data_class"),
      level: enumAt(p, "level", LEVELS),
      recognition: enumAt(p, "recognition", RECOGNITIONS),
      transports: transports.map((t) => enumAt({ t: t }, "t", TRANSPORTS)),
      escalation: optStringAt(p, "escalation"),
      reciprocity: optStringAt(p, "reciprocity"),
    });
  }
  const version = v["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new ShapeError("version: expected a non-negative integer");
  }
  const signature = objectAt(v["signature"], "signature");
  const signatureValue = signature["signature"];
  if (signatureValue !== null && !Array.isArray(signatureValue)) {
    throw new ShapeError("signature.signature: expected an array or null");
  }
  return {
    declarer: stringAt(v, "declarer"),
    counterpart: stringAt(v, "counterpart"),
    version,
    postures,
    valid_from: stringAt(v, "valid_from"),
    valid_to: optStringAt(v, "valid_to"),
    signature: {
      suite: stringAt(signature, "suite"),
      key_id: stringAt(signature, "key_id"),
      signature: signatureValue as number[] | null,
    },
  };
}

export function parseDeclarations(value: unknown): InteropDeclaration[] {
  if (!Array.isArray(value)) throw new ShapeError("declarations: expected an array");
  return value.map(parseDeclaration);
}

export type Permission =
  | { kind: "permitted"; level: HarmonizationLevel; recognition: RecognitionMode }
  | { kind: "refused"; reason: string }
  | { kind: "no-declaration" };

function postureFor(d: InteropDeclaration, dataClass: string): ClassPosture | undefined {
  return (
    d.postures.find((p) => p.data_class === dataClass) ??
    d.postures.find((p) => p.data_class === "*")
  );
}

// Rust max_by_key keeps the LAST maximum, so ties resolve to the later declaration.
function latestFor(set: InteropDeclaration[], declarer: string, counterpart: string): InteropDeclaration | undefined {
  let best: InteropDeclaration | undefined;
  for (const d of set) {
    if (d.declarer === declarer && d.counterpart === counterpart) {
      if (best === undefined || d.version >= best.version) best = d;
    }
  }
  return best;
}

export function permits(
  set: InteropDeclaration[],
  declarer: string,
  counterpart: string,
  dataClass: string,
  transport: TransportMode,
): Permission {
  let posture: ClassPosture | undefined;
  for (const c of [counterpart, "*"]) {
    const d = latestFor(set, declarer, c);
    posture = d ? postureFor(d, dataClass) : undefined;
    if (posture) break;
  }
  if (!posture) return { kind: "no-declaration" };
  if (posture.level === "l0") {
    return {
      kind: "refused",
      reason: `\`${declarer}\` declares L0 for class \`${dataClass}\` toward \`${counterpart}\` — the WILL gap, never brokered around`,
    };
  }
  if (!posture.transports.includes(transport)) {
    const offered = `[${posture.transports.map((t) => TRANSPORT_DEBUG[t]).join(", ")}]`;
    return {
      kind: "refused",
      reason: `\`${declarer}\` offers ${offered} for class \`${dataClass}\` toward \`${counterpart}\`, not \`${transport}\``,
    };
  }
  return { kind: "permitted", level: posture.level, recognition: posture.recognition };
}
