export type Decision = "allow" | "deny" | "escalate" | "modify";

export interface ScenarioStep {
  tool: string;
  payload?: Record<string, unknown>;
  expect?: Decision;
  // Optional per-step agent override
  agent_id?: string;
}

export interface Scenario {
  name: string;
  agent_id: string;
  steps: ScenarioStep[];
}

export interface CIConfig {
  api_url?: string;
  scenarios: Scenario[];
}

export interface StepResult {
  scenario: string;
  step: number;
  tool: string;
  expected: Decision | null;
  decision: Decision;
  risk_score: number;
  reason: string;
  passed: boolean;
  duration_ms: number;
}

export interface ScenarioResult {
  name: string;
  steps: StepResult[];
  passed: boolean;
}

export interface EvaluateResponse {
  callId: string;
  decision: string;
  reason: string;
  riskScore: number;
  latencyMs: number;
}

// ─── Verdict regression ───────────────────────────────────────────────────────

/** A policy file in the repo: the proposed state of the world, not a patch. */
export interface PolicyFile {
  policies: Array<{
    name: string;
    description?: string | null;
    severity_level: "low" | "medium" | "high" | "critical";
    rule_json: { rules: Array<{ id: string; if: string; then: string; description?: string }> };
  }>;
}

export interface VerdictFlip {
  call_id: string;
  action_type: string;
  agent_name: string;
  before: Decision;
  after: Decision;
  direction: "tightened" | "loosened" | "changed";
  before_reason: string;
  after_reason: string;
  risk_before: number;
  risk_after: number;
  created_at: string;
}

export interface PolicyDiffResponse {
  replayed: number;
  unchanged: number;
  flips: VerdictFlip[];
  summary: {
    tightened: number;
    loosened: number;
    changed: number;
    affected_tools: Array<{ action_type: string; count: number }>;
  };
  has_breaking_changes: boolean;
  has_loosening_changes: boolean;
  /** Pre-rendered markdown, so the action and the dashboard never disagree. */
  markdown: string;
}
