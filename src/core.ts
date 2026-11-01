// ─── Core library ──────────────────────────────────────────────────────────────
//
// The parts of @octri/mcp a host builds on: `createServer` with a live or
// static tool source, the transports, configuration, permissions and usage
// reporting. The `octri-mcp` command is one host; a server published under a
// customer's own name and an Octri-hosted endpoint are the others.

export {
  createServer,
  findServedTool,
  type ServedTool,
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
export { DEFAULT_ENV_PREFIX, dropUnsetConfig, envName, processEnv, readEnv, type EnvSource } from "./env.js";
export {
  canAskForApproval,
  chainGate,
  chainKey,
  chainNeedsApproval,
  isReadMethod,
  needsApproval,
  operationAnnotations,
  sendGate,
  toolPolicy,
  userAllowsChain,
  userAllowsTool,
  type PolicySubject,
  type ToolPolicy,
} from "./permissions.js";
export {
  buildOperationRequest,
  buildRequestBody,
  executeOperation,
  formatResponse,
  missingRequired,
  previewBody,
  effectiveBaseUrl,
  resolveOperationUrl,
  sendOperationRequest,
  serializeRequestBody,
  type BuiltRequest,
  type HttpMapping,
  type McpToolsResponse,
  type OperationTool,
  type PendingRequest,
  type SentResponse,
} from "./operations.js";
export {
  CHAIN_TIMEOUT_MS,
  describePlan,
  parseRef,
  planChain,
  resolveTemplate,
  runChain,
  splitTemplate,
  type ChainGate,
  type ChainRef,
  type ChainStep,
  type ChainTool,
  type PlannedStep,
  type RunChainOptions,
  type StepEvent,
} from "./chains.js";
export { getPrompt, listPrompts, type PromptTemplate } from "./prompts.js";
export { findResource, listResources, readResource, type ResourceEntry } from "./resources.js";
export { processUsageReporter, UsageReporter, type CallEvent, type CallOutcome } from "./usage.js";
export {
  auditArguments,
  isWriteCall,
  LIMIT_WINDOW_MS,
  limitResult,
  MemoryCallLimiter,
  perMinuteCap,
  processCallLimiter,
  SessionLimits,
  type AuditEvent,
  type CallLimiter,
  type LimitHit,
  type ToolLimits,
  type WindowCount,
} from "./limits.js";
export {
  changeNote,
  changesForGroup,
  CHANGES_META_KEY,
  foldChanges,
  oldNameAnswer,
  releasesSince,
  WHAT_CHANGED,
  whatChangedResult,
  type ChangesSince,
  type FoldedChange,
  type ToolChange,
  type ToolChanges,
  type ToolRelease,
} from "./changes.js";
export { changeStatePath, localChangeState, type LocalChangeState } from "./change-state.js";
export {
  chainStatus,
  clearStatusCache,
  httpStatusSource,
  isKnownOutage,
  operationStatus,
  outageResult,
  readOutageStatus,
  statusApplies,
  statusNote,
  STATUS_META_KEY,
  type EndpointStatus,
  type OutageStatus,
  type StatusSource,
  type ToolStatus,
} from "./status.js";
export {
  buildErrorGuide,
  credentialVarNames,
  ERROR_GUIDE_MAX_CHARS,
  ERROR_GUIDE_SCHEMA_MAX_CHARS,
  retryAfterSeconds,
  type CredentialOrigin,
  type ErrorGuide,
  type ErrorGuideInput,
} from "./error-guide.js";
export { narrowToGroup, servedGroup, UnknownGroupError, type ToolGroup } from "./groups.js";
export { formatChangelog, isDocsTool, runDocsTool } from "./docs-tools.js";
export {
  buildToolIndex,
  isMetaTool,
  parseToolMode,
  resolveToolMode,
  SEARCH_MODE_THRESHOLD,
  searchModeTools,
  searchTools,
  type ToolMode,
} from "./tool-search.js";
export { formatDoctor, runDoctor, type DoctorCheck, type DoctorOptions } from "./doctor.js";
export {
  envHasCredential,
  KEYCHAIN_SUFFIXES,
  runLogin,
  runLogout,
  systemKeychain,
  terminalIo,
  withKeychainCredential,
  type CredentialSource,
  type CredentialStore,
  type LoginIo,
} from "./keychain.js";
export {
  echoInto,
  matchPracticeRoute,
  PRACTICE_BASE_URL,
  PRACTICE_CONTROL,
  PRACTICE_HEADER,
  PRACTICE_INSTRUCTIONS,
  PRACTICE_LIMITS,
  PRACTICE_META_KEY,
  PRACTICE_OFF_TEXT,
  PRACTICE_TOOL_PREFIX,
  practiceFetch,
  practiceManifest,
  practiceRoutes,
  PracticeSession,
  type PracticeData,
  type PracticeShape,
} from "./practice.js";
export {
  generateFromSchema,
  mergeAllOf,
  PRACTICE_MAX_CHARS,
  PRACTICE_MAX_DEPTH,
  seedFrom,
  stringForPattern,
  type JsonSchema,
} from "./practice-schema.js";
export {
  codeModeTools,
  DEFAULT_RUN_LIMITS,
  DESCRIBE_SDK,
  describeSdkText,
  envelopeFor,
  isCodeTool,
  pythonProgram,
  RUN_CODE,
  typeScriptProgram,
  type CallEnvelope,
  type RunLimits,
} from "./code-mode.js";
export {
  CODE_LANGUAGES,
  isCodeLanguage,
  sdkMethods,
  signature,
  snakeCase,
  type CodeLanguage,
  type CodeModeManifest,
  type SdkMethod,
} from "./code-sdk.js";
export {
  DEFAULT_SANDBOX_LIMITS,
  WORKER_SANDBOX_LIMITS,
  type CodeSandbox,
  type SandboxBridge,
  type SandboxJob,
  type SandboxLimits,
  type SandboxOutcome,
  type SandboxWasm,
} from "./code-sandbox.js";
export { loadSandboxWasm, nodeCodeSandbox, type NodeSandboxOptions } from "./code-sandbox-node.js";
export type { WasmModule } from "./code-wasm.js";
