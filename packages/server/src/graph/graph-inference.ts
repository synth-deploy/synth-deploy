import crypto from "node:crypto";
import { z } from "zod";
import type {
  DeploymentGraph,
  DeploymentGraphNode,
  DeploymentGraphEdge,
} from "@synth-deploy/core";
import type { LlmClient, LlmResult, IArtifactStore } from "@synth-deploy/core";
import { sanitizeForPrompt } from "@synth-deploy/core";

// ---------------------------------------------------------------------------
// Zod schema for LLM graph inference response validation
// ---------------------------------------------------------------------------

const InferredEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: z.enum(["depends_on", "data_flow"]),
  dataBinding: z.object({
    outputName: z.string(),
    inputVariable: z.string(),
  }).optional(),
});

const GraphInferenceResponseSchema = z.object({
  edges: z.array(InferredEdgeSchema),
  reasoning: z.string().optional(),
});

// ---------------------------------------------------------------------------
// GraphInferenceEngine — uses LLM to reason about deployment ordering
// ---------------------------------------------------------------------------

interface InferGraphParams {
  artifactIds: string[];
  envoyAssignments: Record<string, string>; // artifactId -> envoyId
  partitionId?: string;
  graphName?: string;
}

const GRAPH_INFERENCE_SYSTEM_PROMPT = `You are a deployment orchestration expert. Given a set of deployment artifacts with their analyses, determine the correct execution order and any data flow between them.

Your response must be valid JSON with this structure:
{
  "edges": [
    {
      "from": "<artifactId that must deploy FIRST>",
      "to": "<artifactId that depends on it>",
      "type": "depends_on" | "data_flow",
      "dataBinding": { "outputName": "<name>", "inputVariable": "<var>" }  // only for data_flow edges
    }
  ],
  "reasoning": "Plain-language explanation of why this ordering was chosen."
}

Rules:
- "from" deploys BEFORE "to"
- Only add edges where there is a genuine dependency (shared database, API dependency, config requirement)
- Use "data_flow" when one artifact produces a value (e.g., a URL, port, hostname) that another needs
- Use "depends_on" for ordering-only dependencies (e.g., database must be up before the app)
- Do not create cycles
- If artifacts are independent, return an empty edges array`;

export class GraphInferenceEngine {
  constructor(
    private llm: LlmClient,
    private artifactStore: IArtifactStore,
  ) {}

  /**
   * Infer a deployment graph from a set of artifacts and their envoy assignments.
   * Uses the LLM to reason about ordering and data flow when available.
   * Falls back to a flat graph (all parallel) when LLM is unavailable.
   */
  async inferGraph(params: InferGraphParams): Promise<DeploymentGraph> {
    const { artifactIds, envoyAssignments, partitionId, graphName } = params;
    const now = new Date();

    // Build nodes from artifact/envoy assignments
    const nodes: DeploymentGraphNode[] = artifactIds.map((artifactId) => ({
      id: crypto.randomUUID(),
      artifactId,
      envoyId: envoyAssignments[artifactId] ?? "",
      outputBindings: [],
      inputBindings: [],
      status: "pending" as const,
    }));

    // Map from artifactId to nodeId for edge resolution
    const artifactToNodeId = new Map<string, string>();
    for (const node of nodes) {
      artifactToNodeId.set(node.artifactId, node.id);
    }

    let edges: DeploymentGraphEdge[] = [];

    // Attempt LLM inference
    if (this.llm.isAvailable() && artifactIds.length > 1) {
      edges = await this._inferEdgesWithLlm(artifactIds, artifactToNodeId);
    }

    return {
      id: crypto.randomUUID(),
      name: graphName ?? `Graph ${now.toISOString().slice(0, 19)}`,
      partitionId,
      nodes,
      edges,
      status: "draft",
      approvalMode: "graph",
      createdAt: now,
      updatedAt: now,
    };
  }

  private async _inferEdgesWithLlm(
    artifactIds: string[],
    artifactToNodeId: Map<string, string>,
  ): Promise<DeploymentGraphEdge[]> {
    // Build context from artifact analyses
    const artifactContext: string[] = [];
    for (const artifactId of artifactIds) {
      const artifact = this.artifactStore.get(artifactId);
      if (!artifact) {
        artifactContext.push(`- ${artifactId}: (artifact not found)`);
        continue;
      }

      artifactContext.push(
        `- ID: ${artifactId}\n` +
        `  Name: ${sanitizeForPrompt(artifact.name)}\n` +
        `  Type: ${sanitizeForPrompt(artifact.type)}\n` +
        `  Summary: ${sanitizeForPrompt(artifact.analysis.summary)}\n` +
        `  Dependencies: ${sanitizeForPrompt(JSON.stringify(artifact.analysis.dependencies))}\n` +
        `  Config expectations: ${sanitizeForPrompt(JSON.stringify(artifact.analysis.configurationExpectations))}\n` +
        `  Deployment intent: ${sanitizeForPrompt(artifact.analysis.deploymentIntent ?? "unknown")}`,
      );
    }

    const prompt = `Determine the deployment ordering for these artifacts:\n\n${artifactContext.join("\n\n")}\n\nArtifact IDs to use in edges: ${JSON.stringify(artifactIds)}`;

    let result: LlmResult;
    try {
      result = await this.llm.reason({
        prompt,
        systemPrompt: GRAPH_INFERENCE_SYSTEM_PROMPT,
        promptSummary: `Graph inference for ${artifactIds.length} artifacts`,
      });
    } catch {
      return [];
    }

    if (!result.ok) return [];

    try {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];

      const raw = JSON.parse(jsonMatch[0]);
      const parseResult = GraphInferenceResponseSchema.safeParse(raw);
      if (!parseResult.success) return [];

      const parsed = parseResult.data;

      // Convert artifact-level edges to node-level edges
      const graphEdges: DeploymentGraphEdge[] = [];
      for (const edge of parsed.edges) {
        const fromNodeId = artifactToNodeId.get(edge.from);
        const toNodeId = artifactToNodeId.get(edge.to);
        if (!fromNodeId || !toNodeId) continue;

        graphEdges.push({
          from: fromNodeId,
          to: toNodeId,
          type: edge.type === "data_flow" ? "data_flow" : "depends_on",
          dataBinding: edge.dataBinding,
        });
      }

      return graphEdges;
    } catch {
      return [];
    }
  }
}
