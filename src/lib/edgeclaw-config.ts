/**
 * lib/edgeclaw-config.ts
 *
 * EdgeClaw configuration model, validation, and R2 storage helpers.
 */

export type AIGatewayRouteClass = "utility" | "tools" | "reasoning" | "vision";

export interface EdgeClawModelConfig {
  provider: string;
  name: string;
  config?: Record<string, unknown>;
  useAIGateway?: boolean;
  routeClass?: AIGatewayRouteClass;
}

export interface EdgeClawAIGatewayRouteClassConfig {
  enabled: boolean;
  route: string;
  model?: string;
  description?: string;
  headers?: Record<string, string>;
}

export interface EdgeClawAIGatewaySelectionRule {
  routeClass: AIGatewayRouteClass;
  taskTypes?: string[];
  workflowTypes?: string[];
  agentRoles?: string[];
}

export interface EdgeClawAIGatewayConfig {
  enabled: boolean;
  baseUrl?: string;
  defaultRouteClass?: AIGatewayRouteClass;
  routeClasses: Record<AIGatewayRouteClass, EdgeClawAIGatewayRouteClassConfig>;
  routes?: Partial<{
    classifier: AIGatewayRouteClass;
    analyst: AIGatewayRouteClass;
    audit: AIGatewayRouteClass;
    chatFreeform: AIGatewayRouteClass;
    chatDeepReasoning: AIGatewayRouteClass;
  }>;
  selectionRules?: EdgeClawAIGatewaySelectionRule[];
}

export interface AgentPersona {
  name: string;
  systemPrompt?: string;
  enabled: boolean;
  capabilities?: string[];
  allowedTools?: string[];
  model?: EdgeClawModelConfig;
  custom?: Record<string, unknown>;
}

export interface EdgeClawConfig {
  metadata: {
    version: string;
    name: string;
    description?: string;
    orgId: string;
    createdAt: string;
    updatedAt: string;
    createdBy?: string;
  };

  agents: {
    analyst?: AgentPersona;
    dispatcher?: AgentPersona;
    chat?: AgentPersona;
    [key: string]: AgentPersona | undefined;
  };

  features: {
    chatTaskCreation: boolean;
    approvalWorkflows: boolean;
    auditMode: boolean;
    aiGatewayIntegration: boolean;
    worklogPersistence: boolean;
    [key: string]: boolean | string | Record<string, unknown>;
  };

  models: {
    default: EdgeClawModelConfig;
    byTaskType?: {
      [taskType: string]: EdgeClawModelConfig;
    };
    byAgent?: {
      [agentName: string]: EdgeClawModelConfig;
    };
  };

  aiGateway?: EdgeClawAIGatewayConfig;

  channels: {
    [key: string]: Record<string, unknown>;
  };

  security: {
    approvalRules: {
      onEscalation: boolean;
      auditScoreThreshold?: number;
      domainsRequiringApproval?: string[];
      taskTypesRequiringApproval?: string[];
    };
    approvalRoles: string[];
    allowedAccessTeams?: string[];
    allowApiKeyAuth: boolean;
    rateLimiting?: {
      [key: string]: number;
    };
  };

  storage: {
    artifactBucket: string;
    worklogBucket: string;
    orgPrefix: string;
    versionedConfigHistory: boolean;
  };

  custom?: Record<string, unknown>;
  environments?: {
    [envName: string]: Partial<EdgeClawConfig>;
  };
}

export function validateEdgeClawConfig(obj: unknown): {
  ok: boolean;
  errors?: string[];
  config?: EdgeClawConfig;
} {
  const errors: string[] = [];
  const validRouteClasses: AIGatewayRouteClass[] = ["utility", "tools", "reasoning", "vision"];

  if (!obj || typeof obj !== "object") {
    return { ok: false, errors: ["Config must be an object"] };
  }

  const cfg = obj as Record<string, unknown>;

  // Required top-level fields
  if (!cfg.metadata || typeof cfg.metadata !== "object") {
    errors.push("metadata is required and must be an object");
  } else {
    const meta = cfg.metadata as Record<string, unknown>;
    if (typeof meta.version !== "string") {
      errors.push("metadata.version is required and must be a string");
    } else {
      // Semantic version check
      if (!/^\d+\.\d+\.\d+/.test(meta.version)) {
        errors.push(`metadata.version must be semantic version format (got: ${meta.version})`);
      }
    }
    if (typeof meta.orgId !== "string") {
      errors.push("metadata.orgId is required and must be a string");
    }
  }

  if (!cfg.storage || typeof cfg.storage !== "object") {
    errors.push("storage is required and must be an object");
  } else {
    const storage = cfg.storage as Record<string, unknown>;
    if (typeof storage.artifactBucket !== "string") {
      errors.push("storage.artifactBucket is required");
    }
    if (typeof storage.orgPrefix !== "string") {
      errors.push("storage.orgPrefix is required");
    }
  }

  if (!cfg.features || typeof cfg.features !== "object") {
    errors.push("features is required and must be an object");
  }

  if (!cfg.models || typeof cfg.models !== "object") {
    errors.push("models is required and must be an object");
  }

  if (!cfg.security || typeof cfg.security !== "object") {
    errors.push("security is required and must be an object");
  }

  if (!cfg.channels || typeof cfg.channels !== "object") {
    errors.push("channels is required and must be an object");
  }

  if (cfg.aiGateway !== undefined) {
    if (typeof cfg.aiGateway !== "object" || cfg.aiGateway === null) {
      errors.push("aiGateway must be an object when provided");
    } else {
      const aiGateway = cfg.aiGateway as Record<string, unknown>;
      const routeClasses = aiGateway.routeClasses;
      if (routeClasses !== undefined) {
        if (typeof routeClasses !== "object" || routeClasses === null) {
          errors.push("aiGateway.routeClasses must be an object");
        } else {
          for (const routeClass of validRouteClasses) {
            const entry = (routeClasses as Record<string, unknown>)[routeClass];
            if (entry === undefined) continue;
            if (typeof entry !== "object" || entry === null) {
              errors.push(`aiGateway.routeClasses.${routeClass} must be an object`);
              continue;
            }
            const routeObj = entry as Record<string, unknown>;
            if (typeof routeObj.enabled !== "boolean") {
              errors.push(`aiGateway.routeClasses.${routeClass}.enabled must be a boolean`);
            }
            if (typeof routeObj.route !== "string" || routeObj.route.trim().length === 0) {
              errors.push(`aiGateway.routeClasses.${routeClass}.route must be a non-empty string`);
            }
          }
        }
      }

      const routes = (cfg.aiGateway as Record<string, unknown>).routes;
      if (routes !== undefined) {
        if (typeof routes !== "object" || routes === null || Array.isArray(routes)) {
          errors.push("aiGateway.routes must be an object when provided");
        } else {
          for (const [assignmentKey, assignedClass] of Object.entries(routes as Record<string, unknown>)) {
            if (typeof assignedClass !== "string") {
              errors.push(`aiGateway.routes.${assignmentKey} must be a string`);
            } else if (!(validRouteClasses as string[]).includes(assignedClass)) {
              errors.push(
                `aiGateway.routes.${assignmentKey} has invalid route class "${assignedClass}"; must be one of: ${validRouteClasses.join(", ")}`
              );
            }
          }
        }
      }
    }
  }

  // Business logic validation
  const baseCfg = cfg as Partial<EdgeClawConfig>;

  const analystCfg = baseCfg.models?.byAgent?.analyst;
  if (analystCfg?.routeClass && !validRouteClasses.includes(analystCfg.routeClass)) {
    errors.push("models.byAgent.analyst.routeClass must be one of: utility, tools, reasoning, vision.");
  }

  if (analystCfg?.useAIGateway) {
    if (!analystCfg.routeClass) {
      errors.push("models.byAgent.analyst.routeClass is required when analyst useAIGateway is enabled.");
    } else {
      const selectedClassCfg = baseCfg.aiGateway?.routeClasses?.[analystCfg.routeClass];
      if (!selectedClassCfg) {
        errors.push(`aiGateway.routeClasses.${analystCfg.routeClass} must be configured when analyst useAIGateway is enabled.`);
      }
    }
  }

  if (!baseCfg.features?.approvalWorkflows && baseCfg.security?.approvalRoles?.length) {
    errors.push("Cannot have approval roles when approvalWorkflows is disabled");
  }

  if (!baseCfg.features?.auditMode && baseCfg.security?.approvalRules?.onEscalation) {
    errors.push("Cannot require approval on escalation when auditMode is disabled");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, config: cfg as unknown as EdgeClawConfig };
}

export function nextVersion(currentVersion: string): string {
  const parts = currentVersion.split(".");
  if (parts.length < 3) {
    return "1.0.0";
  }
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);
  const patch = parseInt(parts[2], 10);

  // Increment patch version
  return `${major}.${minor}.${patch + 1}`;
}

export interface ConfigChangeEntry {
  timestamp: string;
  version: string;
  actor: string;
  summary: string;
}
