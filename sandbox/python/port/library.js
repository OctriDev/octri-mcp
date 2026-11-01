// The sandbox's only imports. Each one hands off to a callback the host sets
// on the module object before it runs a script (see src/code-sandbox-python.ts).

addToLibrary({
  octri_write: (stream, ptr, len) => {
    Module.octriWrite(stream, UTF8ToString(ptr, len));
  },

  octri_should_stop: () => (Module.octriShouldStop() ? 1 : 0),

  octri_result: (ptr, len) => {
    Module.octriResult(UTF8ToString(ptr, len));
  },

  // Async: Asyncify unwinds the wasm stack while the host runs the operation,
  // then rewinds it with the answer. The C side frees the returned buffer.
  octri_call__async: true,
  octri_call: (namePtr, nameLen, argsPtr, argsLen, outLenPtr) =>
    Asyncify.handleAsync(async () => {
      const answer = await Module.octriCall(UTF8ToString(namePtr, nameLen), UTF8ToString(argsPtr, argsLen));
      if (typeof answer !== "string") return 0;
      const size = lengthBytesUTF8(answer);
      const out = _malloc(size + 1);
      if (out === 0) return 0;
      stringToUTF8(answer, out, size + 1);
      HEAPU32[outLenPtr >> 2] = size;
      return out;
    }),
});
