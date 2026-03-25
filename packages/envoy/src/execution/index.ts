// ---------------------------------------------------------------------------
// Execution engine — re-exports
// ---------------------------------------------------------------------------

// Core executor
export { DefaultOperationExecutor } from "./operation-executor.js";
export type {
  ExecutionProgressEvent,
  ProgressCallback,
  PlanExecutionResult,
  DryRunPlanResult,
} from "./operation-executor.js";

// Script runner
export { ScriptRunner } from "./script-runner.js";
export type {
  ScriptResult,
  ScriptedPlanResult,
  ScriptProgressEvent,
  ScriptProgressCallback,
} from "./script-runner.js";

// Boundary validation
export { BoundaryValidator } from "./boundary-validator.js";
export type {
  ScriptValidationResult,
} from "./boundary-validator.js";

// LLM boundary audit (opt-in)
export { auditScriptBoundaries } from "./llm-boundary-audit.js";
export type {
  BoundaryAuditResult,
  AuditLlmClient,
} from "./llm-boundary-audit.js";

// Platform abstraction
export { createPlatformAdapter } from "./platform.js";
export type {
  Platform,
  PlatformAdapter,
  ServiceManager,
  FilesystemOps,
} from "./platform.js";
export { LinuxPlatformAdapter } from "./platform/linux.js";
