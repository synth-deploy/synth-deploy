/**
 * Playbook type definitions — declarative scenario testing for all operation types.
 */

export type OperationType = "deploy" | "maintain" | "query" | "investigate" | "trigger" | "composite";

export interface PlaybookSetupEntity {
  name: string;
  variables?: Record<string, string>;
}

export interface PlaybookSetup {
  environments?: PlaybookSetupEntity[];
  partitions?: PlaybookSetupEntity[];
  artifacts?: Array<{ name: string; type?: string }>;
}

export interface PlaybookOperation {
  type: OperationType;
  intent?: string;
  environmentRef?: string;
  partitionRef?: string;
  artifactRef?: string;
  version?: string;
  allowWrite?: boolean;
  condition?: string;
  responseIntent?: string;
  requireApproval?: boolean;
  operations?: Array<{
    type: OperationType;
    intent?: string;
    artifactRef?: string;
    condition?: string;
    responseIntent?: string;
  }>;
}

export type PlaybookAssertion =
  | { responseStatus: number }
  | { statusIn: string[] }
  | { hasDebrief: boolean }
  | { debriefMinEntries: number }
  | { errorContains: string };

export interface PlaybookDefinition {
  name: string;
  type: OperationType;
  tags?: string[];
  setup: PlaybookSetup;
  operation: PlaybookOperation;
  assertions: PlaybookAssertion[];
}

export interface AssertionResult {
  assertion: PlaybookAssertion;
  passed: boolean;
  message: string;
}

export interface PlaybookResult {
  name: string;
  type: OperationType;
  passed: boolean;
  assertions: AssertionResult[];
  durationMs: number;
  error?: string;
}
