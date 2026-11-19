// Shared production bundle config: one self-contained ESM file per service.
export const serviceConfig = {
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  splitting: false,
  // Bundle workspace packages and all npm deps so the image only needs `node dist/index.js`.
  noExternal: [/.*/],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
};
