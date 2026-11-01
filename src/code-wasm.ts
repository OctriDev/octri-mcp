// The parts of the WebAssembly API code mode uses. This package compiles with
// the ES2022 lib only, which has no WebAssembly types, and lib.dom would bring
// the whole browser in; a host passes real `WebAssembly.Module`s, which fit.

/** A compiled WebAssembly module, opaque here. */
export interface WasmModule {
  readonly __compiledWasm?: never;
}

export interface WasmInstance {
  readonly exports: Record<string, unknown>;
}

interface WasmApi {
  compile(bytes: Uint8Array): Promise<WasmModule>;
  instantiate(module: WasmModule, imports: object): Promise<WasmInstance>;
}

export const webAssembly = (globalThis as unknown as { WebAssembly: WasmApi }).WebAssembly;
