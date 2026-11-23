declare module "*.yaml" {
  const content: string;
  export default content;
}

declare module "*.wasm" {
  const module: WebAssemblyModule;
  export default module;
}

declare namespace WebAssembly {
  interface ModuleLike {
    readonly [Symbol.toStringTag]: string;
  }
}
