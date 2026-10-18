// ─── Core library ──────────────────────────────────────────────────────────────
//
// The parts of @octri/mcp a host builds on: `createServer` with a live or
// static tool source, the transports, configuration, permissions and usage
// reporting. The `octri-mcp` command is one host; a server published under a
// customer's own name and an Octri-hosted endpoint are the others.

export {
  createServer,
  type CreateServerOptions,
  type OctriProject,
  type ServerBranding,
  type ToolManifest,
  type ToolSource,
} from "./server.js";
export {
  httpRequestRefusal,
  httpStartupRefusal,
  startSse,
  startStdio,
  startStreamableHttp,
  type ServerFactory,
} from "./transports.js";
export {
  DEFAULT_API_URL,
  loadConfig,
  loadUserPermissions,
  noUserLimits,
  SERVER_VERSION,
  type Config,
  type TransportConfig,
  type UserPermissions,
} from "./config.js";
export { DEFAULT_ENV_PREFIX, envName, processEnv, readEnv, type EnvSource } from "./env.js";
export {
  canAskForApproval,
  isReadMethod,
  needsApproval,
  operationAnnotations,
  sendGate,
  toolPolicy,
  userAllowsTool,
  type PolicySubject,
  type ToolPolicy,
} from "./permissions.js";
export {
  buildRequestBody,
  executeOperation,
  missingRequired,
  previewBody,
  resolveOperationUrl,
  serializeRequestBody,
  type HttpMapping,
  type McpToolsResponse,
  type OperationTool,
  type PendingRequest,
} from "./operations.js";
export { processUsageReporter, UsageReporter, type CallEvent, type CallOutcome } from "./usage.js";
export { formatChangelog, isDocsTool, runDocsTool } from "./docs-tools.js";
export { formatDoctor, runDoctor, type DoctorCheck, type DoctorOptions } from "./doctor.js";
