import {
  AIGatewayRouteClass,
  EdgeClawAIGatewaySelectionRule,
  EdgeClawConfig,
} from "./edgeclaw-config";

export interface AIGatewayRouteSelectionInput {
  taskType?: string;
  workflowType?: string;
  agentRole?: string;
  preferredRouteClass?: AIGatewayRouteClass;
}

export type AIGatewayRouteSelectionSource =
  | "preferred"
  | "selection_rule"
  | "gateway_assignment"
  | "model_by_task_type"
  | "model_by_agent"
  | "model_default"
  | "gateway_default"
  | "deterministic_fallback";

export interface AIGatewayRouteSelection {
  enabled: boolean;
  routeClass: AIGatewayRouteClass;
  baseUrl: string | null;
  route: string | null;
  source: AIGatewayRouteSelectionSource;
  reason: string;
}

const DEFAULT_FALLBACK_CLASS: AIGatewayRouteClass = "utility";

export function selectAIGatewayRoute(
  config: EdgeClawConfig | null | undefined,
  input: AIGatewayRouteSelectionInput
): AIGatewayRouteSelection {
  const fallback = (reason: string, routeClass: AIGatewayRouteClass = DEFAULT_FALLBACK_CLASS): AIGatewayRouteSelection => ({
    enabled: false,
    routeClass,
    baseUrl: null,
    route: null,
    source: "deterministic_fallback",
    reason,
  });

  if (!config) {
    return fallback("Config missing.");
  }

  if (!config.features?.aiGatewayIntegration) {
    return fallback("features.aiGatewayIntegration is disabled.");
  }

  const gateway = config.aiGateway;
  if (!gateway || !gateway.enabled) {
    return fallback("aiGateway config is missing or disabled.");
  }

  const baseUrl = normalizeNonEmptyString(gateway.baseUrl);
  if (!baseUrl) {
    return fallback("aiGateway.baseUrl is missing.");
  }

  const classDecision = selectRouteClass(config, input);
  const routeConfig = gateway.routeClasses?.[classDecision.routeClass];

  if (!routeConfig || !routeConfig.enabled || !normalizeNonEmptyString(routeConfig.route)) {
    return fallback(
      `Selected route class \"${classDecision.routeClass}\" is disabled or missing route mapping.`,
      classDecision.routeClass
    );
  }

  return {
    enabled: true,
    routeClass: classDecision.routeClass,
    baseUrl,
    route: normalizeNonEmptyString(routeConfig.route) as string,
    source: classDecision.source,
    reason: classDecision.reason,
  };
}

export function selectRouteClass(
  config: EdgeClawConfig,
  input: AIGatewayRouteSelectionInput
): { routeClass: AIGatewayRouteClass; source: Exclude<AIGatewayRouteSelectionSource, "deterministic_fallback">; reason: string } {
  if (input.preferredRouteClass) {
    return {
      routeClass: input.preferredRouteClass,
      source: "preferred",
      reason: "Caller provided preferredRouteClass.",
    };
  }

  const matchedRule = findBestRule(config.aiGateway?.selectionRules, input);
  if (matchedRule) {
    return {
      routeClass: matchedRule.routeClass,
      source: "selection_rule",
      reason: "Matched aiGateway.selectionRules.",
    };
  }

  const assignedRouteClass = getAssignedRouteClass(config, input);
  if (assignedRouteClass) {
    return {
      routeClass: assignedRouteClass,
      source: "gateway_assignment",
      reason: "Matched aiGateway.routes assignment.",
    };
  }

  if (input.taskType) {
    const byTaskType = config.models?.byTaskType?.[input.taskType];
    if (byTaskType?.routeClass) {
      return {
        routeClass: byTaskType.routeClass,
        source: "model_by_task_type",
        reason: "Matched models.byTaskType routeClass.",
      };
    }
  }

  if (input.agentRole) {
    const byAgent = config.models?.byAgent?.[input.agentRole];
    if (byAgent?.routeClass) {
      return {
        routeClass: byAgent.routeClass,
        source: "model_by_agent",
        reason: "Matched models.byAgent routeClass.",
      };
    }
  }

  if (config.models?.default?.routeClass) {
    return {
      routeClass: config.models.default.routeClass,
      source: "model_default",
      reason: "Using models.default.routeClass.",
    };
  }

  if (config.aiGateway?.defaultRouteClass) {
    return {
      routeClass: config.aiGateway.defaultRouteClass,
      source: "gateway_default",
      reason: "Using aiGateway.defaultRouteClass.",
    };
  }

  return {
    routeClass: DEFAULT_FALLBACK_CLASS,
    source: "gateway_default",
    reason: "No explicit route class configured; defaulted to utility.",
  };
}

function findBestRule(
  rules: EdgeClawAIGatewaySelectionRule[] | undefined,
  input: AIGatewayRouteSelectionInput
): EdgeClawAIGatewaySelectionRule | null {
  if (!rules || rules.length === 0) return null;

  let bestRule: EdgeClawAIGatewaySelectionRule | null = null;
  let bestScore = -1;

  for (const rule of rules) {
    const score = scoreRule(rule, input);
    if (score > bestScore) {
      bestScore = score;
      bestRule = rule;
    }
  }

  return bestScore >= 0 ? bestRule : null;
}

function scoreRule(rule: EdgeClawAIGatewaySelectionRule, input: AIGatewayRouteSelectionInput): number {
  let score = 0;

  if (rule.taskTypes) {
    if (!input.taskType || !rule.taskTypes.includes(input.taskType)) return -1;
    score += 4;
  }

  if (rule.workflowTypes) {
    if (!input.workflowType || !rule.workflowTypes.includes(input.workflowType)) return -1;
    score += 3;
  }

  if (rule.agentRoles) {
    if (!input.agentRole || !rule.agentRoles.includes(input.agentRole)) return -1;
    score += 2;
  }

  // Prefer rules that specify more dimensions when scores tie.
  const specificity = [rule.taskTypes, rule.workflowTypes, rule.agentRoles].filter(Boolean).length;
  return score + specificity;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getAssignedRouteClass(
  config: EdgeClawConfig,
  input: AIGatewayRouteSelectionInput
): AIGatewayRouteClass | null {
  const routes = config.aiGateway?.routes;
  if (!routes) return null;

  // Current runtime authority is intentionally limited to analyst assignment.
  // Other UI assignments remain metadata until their runtime call sites are wired.
  if (input.agentRole === "analyst") {
    const assigned = routes.analyst;
    if (assigned === "utility" || assigned === "tools" || assigned === "reasoning" || assigned === "vision") {
      return assigned;
    }
  }

  return null;
}
