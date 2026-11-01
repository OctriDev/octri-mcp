// The entry point of this server's MCP Bundle (`.mcpb`, see scripts/pack-mcpb.mjs).
//
// A bundle's client passes every setting in its manifest, filled or not, so the
// empty ones go before the server reads its environment. The server is imported
// afterwards, not statically: a static import would run it first.

import { DEFAULT_ENV_PREFIX, dropUnsetConfig } from "./env.js";

dropUnsetConfig(DEFAULT_ENV_PREFIX);

await import("./index.js");
