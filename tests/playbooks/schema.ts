/**
 * Zod validation for playbook YAML files.
 */
import { z } from "zod";

const OperationTypeEnum = z.enum(["deploy", "maintain", "query", "investigate", "execute", "trigger", "composite"]);

const SetupEntitySchema = z.object({
  name: z.string().min(1),
  variables: z.record(z.string()).optional(),
});

const SetupArtifactSchema = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
});

const SetupSchema = z.object({
  environments: z.array(SetupEntitySchema).optional(),
  partitions: z.array(SetupEntitySchema).optional(),
  artifacts: z.array(SetupArtifactSchema).optional(),
}).default({});

const ChildOperationSchema = z.object({
  type: OperationTypeEnum,
  intent: z.string().optional(),
  artifactRef: z.string().optional(),
  condition: z.string().optional(),
  responseIntent: z.string().optional(),
});

const OperationSchema = z.object({
  type: OperationTypeEnum,
  intent: z.string().optional(),
  environmentRef: z.string().optional(),
  partitionRef: z.string().optional(),
  artifactRef: z.string().optional(),
  version: z.string().optional(),
  allowWrite: z.boolean().optional(),
  condition: z.string().optional(),
  responseIntent: z.string().optional(),
  requireApproval: z.boolean().optional(),
  operations: z.array(ChildOperationSchema).optional(),
});

const AssertionSchema = z.union([
  z.object({ responseStatus: z.number() }),
  z.object({ statusIn: z.array(z.string()) }),
  z.object({ hasDebrief: z.boolean() }),
  z.object({ debriefMinEntries: z.number() }),
  z.object({ errorContains: z.string() }),
]);

export const PlaybookSchema = z.object({
  name: z.string().min(1),
  type: OperationTypeEnum,
  tags: z.array(z.string()).optional(),
  setup: SetupSchema,
  operation: OperationSchema,
  assertions: z.array(AssertionSchema).min(1),
});
