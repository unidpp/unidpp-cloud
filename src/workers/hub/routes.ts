export const paths = {
  root: "/",
  healthz: "/healthz",
  keyring: "/keyring",
  relay: "/relay",
  relayVerify: "/relay/verify",
  contractYaml: "/openapi.yaml",
  contractJson: "/openapi.json",
} as const;

export const routedPaths: readonly string[] = [
  paths.root,
  paths.healthz,
  paths.keyring,
  paths.relay,
  paths.relayVerify,
];

export const verbs = ["get", "post", "put", "delete", "patch"] as const;
