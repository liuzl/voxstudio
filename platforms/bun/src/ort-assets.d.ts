// The `with { type: "file" }` imports in silero.ts resolve to a path string at
// runtime (and to an embedded asset inside a compiled binary); TypeScript has no
// native notion of Bun's file-typed imports, so the two specifiers are declared here.
declare module "onnxruntime-web/ort-wasm-simd-threaded.wasm" {
  const path: string;
  export default path;
}
declare module "onnxruntime-web/ort-wasm-simd-threaded.mjs" {
  const path: string;
  export default path;
}
