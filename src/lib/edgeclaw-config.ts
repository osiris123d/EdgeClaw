/**
 * lib/edgeclaw-config.ts
 *
 * EdgeClaw configuration model, validation, and R2 storage helpers.
 */

export interface AgentPersona {
  name: string;
  systemPrompt?: string;
  enabled: boolean;
  capabilities?: string[];
  allowedTools?: string[];
  model?: {
    provider: string;
    name: string;
    config?: Record<string, unknown>;
  };
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
    default: {
      provider: string;
      name: string;
      config?: Record<string, unknown>;
    };
    byTaskType?: {
      [taskType: string]: {
        provider: string;
        name: string;
        config?: Record<string, unknown>;
      };
    };
    byAgent?: {
      [agentName: string]: {
        provider: string;
        name: string;
        config?: Record<string, unknown>;
      };
    };
  };

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

  // Business logic validation
  const baseCfg = cfg as Partial<EdgeClawConfig>;
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
