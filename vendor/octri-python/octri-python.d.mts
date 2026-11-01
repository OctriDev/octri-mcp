// Types for the emscripten glue of the code mode Python sandbox (built by
// sandbox/python/build.sh). Only what src/code-sandbox-python.ts uses.

export interface OctriPythonModule {
  ccall(name: "octri_exec", returnType: "number", argTypes: ["number", "number"], args: [number, number], options: { async: true }): Promise<number>;
  _octri_init(heapBytes: number, pystackWords: number): void;
  _malloc(size: number): number;
  _free(ptr: number): void;
  lengthBytesUTF8(text: string): number;
  stringToUTF8(text: string, ptr: number, maxBytes: number): void;
}

export interface OctriPythonOptions {
  instantiateWasm(imports: object, done: (instance: never, module: never) => void): object;
  octriWrite(stream: number, text: string): void;
  octriShouldStop(): boolean;
  octriResult(json: string): void;
  octriCall(tool: string, argsJson: string): Promise<string | undefined>;
}

export default function createOctriPython(options: OctriPythonOptions): Promise<OctriPythonModule>;
