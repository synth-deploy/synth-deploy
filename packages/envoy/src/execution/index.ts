// ---------------------------------------------------------------------------
// Execution engine — re-exports
// ---------------------------------------------------------------------------

// Core executor
export { DefaultOperationExecutor } from "./operation-executor.js";
export type {
  OperationResult,
  ExecutionProgressEvent,
  ProgressCallback,
  PlanExecutionResult,
} from "./operation-executor.js";

// Registry
export { DefaultOperationRegistry } from "./operation-registry.js";
export type {
  OperationHandler,
  HandlerResult,
} from "./operation-registry.js";

// Boundary validation
export { BoundaryValidator } from "./boundary-validator.js";
export type {
  ValidationResult,
  PlanValidationResult,
} from "./boundary-validator.js";

// Platform abstraction
export { createPlatformAdapter } from "./platform.js";
export type {
  Platform,
  PlatformAdapter,
  ServiceManager,
  FilesystemOps,
} from "./platform.js";
export { LinuxPlatformAdapter } from "./platform/linux.js";

// Handlers
export { ServiceHandler } from "./handlers/service-handler.js";
export { FileHandler } from "./handlers/file-handler.js";
export { ConfigHandler } from "./handlers/config-handler.js";
export { ProcessHandler } from "./handlers/process-handler.js";
export { ContainerHandler } from "./handlers/container-handler.js";
export { VerifyHandler } from "./handlers/verify-handler.js";
