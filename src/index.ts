import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import type {
  CIConfig, ScenarioResult, StepResult, Decision, EvaluateResponse,
  PolicyFile, PolicyDiffResponse,
} from "./types";

// ─── Config loading ───────────────────────────────────────────────────────────

function loadConfig(configPath: string): CIConfig {
  const abs = path.isAbsolute(configPath)
    ? configPath
    : path.join(process.env.GITHUB_WORKSPACE ?? process.cwd(), configPath);

  if (!fs.existsSync(abs)) {
    throw new Error(`Config file not found: ${abs}\n\nCreate .verdicter/ci.yml in your repository root. See https://verdicter.dev/docs/ci for the format.`);
  }

  const raw = fs.readFileSync(abs, "utf8");
  const parsed = yaml.load(raw) as CIConfig;

  if (!parsed?.scenarios || !Array.isArray(parsed.scenarios)) {
    throw new Error("Config must have a top-level 'scenarios' array.");
  }

  for (const [i, scenario] of parsed.scenarios.entries()) {
    if (!scenario.name) throw new Error(`scenarios[${i}] is missing a 'name' field.`);
    if (!scenario.agent_id) throw new Error(`scenarios[${i}] ('${scenario.name}') is missing an 'agent_id' field.`);
    if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
      throw new Error(`scenarios[${i}] ('${scenario.name}') must have at least one step.`);
    }
    for (const [j, step] of scenario.steps.entries()) {
      if (!step.tool) throw new Error(`scenarios[${i}].steps[${j}] is missing a 'tool' field.`);
    }
  }

  return parsed;
}

// ─── Evaluate a single step ───────────────────────────────────────────────────

async function evaluate(
  apiUrl: string,
  apiKey: string,
  agentId: string,
  tool: string,
  payload: Record<string, unknown>,
): Promise<EvaluateResponse> {
  const url = `${apiUrl.replace(/\/$/, "")}/api/v1/evaluate`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "User-Agent": "verdicter-action/1",
    },
    body: JSON.stringify({ agent_id: agentId, tool, payload: payload ?? {} }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Verdicter API returned ${res.status}: ${body}`);
  }

  return res.json() as Promise<EvaluateResponse>;
}

// ─── Verdict regression ───────────────────────────────────────────────────────

/**
 * Load the proposed policy set from the repository.
 *
 * Accepts either a bare array of policies or an object with a `policies` key, so a
 * file exported from the dashboard works without editing.
 */
function loadPolicyFile(policyPath: string): PolicyFile {
  const abs = path.isAbsolute(policyPath)
    ? policyPath
    : path.join(process.env.GITHUB_WORKSPACE ?? process.cwd(), policyPath);

  if (!fs.existsSync(abs)) {
    throw new Error(`Policy file not found: ${abs}`);
  }

  const raw = fs.readFileSync(abs, "utf8");
  const parsed = (abs.endsWith(".yml") || abs.endsWith(".yaml"))
    ? yaml.load(raw)
    : JSON.parse(raw);

  const policies = Array.isArray(parsed) ? parsed : (parsed as PolicyFile)?.policies;
  if (!Array.isArray(policies)) {
    throw new Error("Policy file must be an array of policies, or an object with a 'policies' array.");
  }

  for (const [i, p] of policies.entries()) {
    if (!p?.name) throw new Error(`policies[${i}] is missing a 'name'.`);
    if (!p?.rule_json?.rules) throw new Error(`policies[${i}] ('${p.name}') is missing 'rule_json.rules'.`);
  }

  return { policies };
}

async function runPolicyDiff(
  apiUrl: string,
  apiKey: string,
  policyFile: PolicyFile,
  replayLimit: number,
): Promise<PolicyDiffResponse> {
  const url = `${apiUrl.replace(/\/$/, "")}/api/v1/policy-diff`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "User-Agent": "verdicter-action/1",
    },
    body: JSON.stringify({ policies: policyFile.policies, limit: replayLimit }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Policy diff returned ${res.status}: ${body}`);
  }

  return res.json() as Promise<PolicyDiffResponse>;
}

// ─── PR comment ───────────────────────────────────────────────────────────────

function decisionIcon(passed: boolean, expected: Decision | null): string {
  if (expected === null) return "⚪";
  return passed ? "✅" : "❌";
}

function decisionBadge(decision: string): string {
  const upper = decision.toUpperCase();
  const map: Record<string, string> = {
    ALLOW: "🟢 ALLOW",
    DENY: "🔴 DENY",
    ESCALATE: "🟡 ESCALATE",
    MODIFY: "🔵 MODIFY",
  };
  return map[upper] ?? upper;
}

function buildComment(
  results: ScenarioResult[],
  totalPassed: number,
  totalFailed: number,
  totalSteps: number,
  diff: PolicyDiffResponse | null = null,
): string {
  const allPassed = totalFailed === 0;
  const header = allPassed
    ? `## ✅ Verdicter CI - All scenarios passed (${totalPassed}/${totalSteps})`
    : `## ❌ Verdicter CI - ${totalFailed} step${totalFailed !== 1 ? "s" : ""} failed (${totalPassed}/${totalSteps} passed)`;

  const sections = results.map((scenario) => {
    const icon = scenario.passed ? "✅" : "❌";
    const rows = scenario.steps.map((step) =>
      `| ${decisionIcon(step.passed, step.expected)} | \`${step.tool}\` | ${step.expected ? decisionBadge(step.expected) : "-"} | ${decisionBadge(step.decision)} | ${step.risk_score} | ${step.duration_ms}ms |`
    ).join("\n");

    return `### ${icon} ${scenario.name}

| | Tool | Expected | Got | Risk | Latency |
|---|---|---|---|---|---|
${rows}`;
  });

  const footer = allPassed
    ? `\n---\n*All policy checks passed. No regressions detected.*`
    : `\n---\n*${totalFailed} step${totalFailed !== 1 ? "s" : ""} produced unexpected decisions. Review your policy changes or update the expected outcomes in \`.verdicter/ci.yml\`.*`;

  // The replay section carries far more signal than the scenario table — it is about
  // real traffic rather than hand-written fixtures — so it goes above the footer.
  const diffSection = diff ? [diff.markdown] : [];

  return [header, ...sections, ...diffSection, footer].join("\n\n");
}

// Direct GitHub REST API calls via fetch — no @actions/github SDK needed
async function postPRComment(token: string, comment: string): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    core.info("No GITHUB_EVENT_PATH - skipping PR comment.");
    return;
  }

  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const pr = event.pull_request;
  if (!pr) {
    core.info("Not a pull request - skipping PR comment.");
    return;
  }

  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  const issueNumber = pr.number as number;
  const apiBase = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Find an existing Verdicter comment to update rather than spamming on re-runs
  const listRes = await fetch(`${apiBase}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`, { headers });
  const existing = listRes.ok
    ? ((await listRes.json()) as Array<{ id: number; body?: string }>).find((c) => c.body?.includes("Verdicter CI"))
    : null;

  if (existing) {
    await fetch(`${apiBase}/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ body: comment }),
    });
  } else {
    await fetch(`${apiBase}/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: comment }),
    });
  }
}

// ─── Job summary ─────────────────────────────────────────────────────────────

async function writeJobSummary(results: ScenarioResult[], totalPassed: number, totalFailed: number, totalSteps: number): Promise<void> {
  const allPassed = totalFailed === 0;

  await core.summary
    .addHeading(allPassed ? `✅ Verdicter CI passed (${totalPassed}/${totalSteps})` : `❌ Verdicter CI failed (${totalFailed} unexpected)`, 2)
    .addTable([
      [
        { data: "Scenario", header: true },
        { data: "Tool", header: true },
        { data: "Expected", header: true },
        { data: "Got", header: true },
        { data: "Risk", header: true },
        { data: "Result", header: true },
      ],
      ...results.flatMap((scenario) =>
        scenario.steps.map((step) => [
          scenario.name,
          `\`${step.tool}\``,
          step.expected ?? "-",
          step.decision.toUpperCase(),
          String(step.risk_score),
          step.passed ? "✅ Pass" : "❌ Fail",
        ])
      ),
    ])
    .write();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const apiKey             = core.getInput("api-key", { required: true });
  const configPath         = core.getInput("config");
  const failOnUnexpected   = core.getInput("fail-on-unexpected") !== "false";
  const shouldComment      = core.getInput("post-comment") !== "false";
  const policyFilePath     = core.getInput("policy-file");
  const failOnRegression   = core.getInput("fail-on-regression") !== "false";
  const replayLimit        = Number(core.getInput("replay-limit") || "500") || 500;

  // Load config
  let config: CIConfig;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    core.setFailed(String(err));
    return;
  }

  const apiUrl = config.api_url ?? core.getInput("api-url");
  core.info(`Verdicter API: ${apiUrl}`);
  core.info(`Loaded ${config.scenarios.length} scenario(s) from ${configPath}`);

  const scenarioResults: ScenarioResult[] = [];
  let totalSteps = 0;
  let totalPassed = 0;
  let totalFailed = 0;

  // Run all scenarios
  for (const scenario of config.scenarios) {
    core.startGroup(`Scenario: ${scenario.name}`);
    const stepResults: StepResult[] = [];
    let scenarioPassed = true;

    for (const [stepIdx, step] of scenario.steps.entries()) {
      const agentId = step.agent_id ?? scenario.agent_id;
      const expected = step.expect ?? null;
      const t0 = Date.now();

      let decision: Decision;
      let riskScore = 0;
      let reason = "";

      try {
        const resp = await evaluate(apiUrl, apiKey, agentId, step.tool, step.payload ?? {});
        decision = resp.decision.toLowerCase() as Decision;
        riskScore = resp.riskScore;
        reason = resp.reason;
      } catch (err) {
        core.error(`Step ${stepIdx + 1} (${step.tool}) - API error: ${err}`);
        decision = "deny";
        reason = String(err);
      }

      const duration = Date.now() - t0;
      const passed = expected === null || decision === expected;

      const result: StepResult = {
        scenario: scenario.name,
        step: stepIdx + 1,
        tool: step.tool,
        expected,
        decision,
        risk_score: riskScore,
        reason,
        passed,
        duration_ms: duration,
      };

      stepResults.push(result);
      totalSteps++;

      if (passed) {
        totalPassed++;
        core.info(`  Step ${stepIdx + 1}: ${step.tool} -> ${decision.toUpperCase()} ✅`);
      } else {
        totalFailed++;
        scenarioPassed = false;
        core.error(`  Step ${stepIdx + 1}: ${step.tool} -> expected ${expected?.toUpperCase()} but got ${decision.toUpperCase()} ❌\n  Reason: ${reason}`);
      }
    }

    scenarioResults.push({ name: scenario.name, steps: stepResults, passed: scenarioPassed });
    core.endGroup();
  }

  // ── Verdict regression against recorded traffic ────────────────────────────
  // Optional: only runs when the repo declares a policy file. This is the check
  // that catches "this edit reads fine but would break 12 live calls".
  let diff: PolicyDiffResponse | null = null;
  if (policyFilePath) {
    core.startGroup("Verdict regression");
    try {
      const policyFile = loadPolicyFile(policyFilePath);
      core.info(`Replaying up to ${replayLimit} recorded calls against ${policyFile.policies.length} proposed policies`);
      diff = await runPolicyDiff(apiUrl, apiKey, policyFile, replayLimit);

      core.info(`Replayed ${diff.replayed} calls: ${diff.flips.length} verdict change(s)`);
      if (diff.summary.tightened > 0) {
        core.warning(`${diff.summary.tightened} call(s) that currently succeed would start being blocked.`);
        for (const f of diff.flips.filter((x) => x.direction === "tightened").slice(0, 10)) {
          core.warning(`  ${f.action_type} (${f.agent_name}): ${f.before.toUpperCase()} → ${f.after.toUpperCase()} - ${f.after_reason}`);
        }
      }
      if (diff.summary.loosened > 0) {
        core.warning(`${diff.summary.loosened} call(s) that are currently blocked would start being allowed.`);
      }
    } catch (err) {
      // A failed replay must not mask the scenario results, which are the primary check.
      core.warning(`Verdict regression skipped: ${err}`);
    }
    core.endGroup();
  }

  // Set outputs
  core.setOutput("total", String(totalSteps));
  core.setOutput("passed", String(totalPassed));
  core.setOutput("failed", String(totalFailed));
  core.setOutput("result", totalFailed === 0 ? "pass" : "fail");
  core.setOutput("replayed", String(diff?.replayed ?? 0));
  core.setOutput("verdict-changes", String(diff?.flips.length ?? 0));
  core.setOutput("newly-blocked", String(diff?.summary.tightened ?? 0));
  core.setOutput("newly-allowed", String(diff?.summary.loosened ?? 0));

  // Job summary
  await writeJobSummary(scenarioResults, totalPassed, totalFailed, totalSteps);

  // PR comment
  const githubToken = core.getInput("github-token") || process.env.GITHUB_TOKEN;
  if (shouldComment && githubToken) {
    try {
      const comment = buildComment(scenarioResults, totalPassed, totalFailed, totalSteps, diff);
      await postPRComment(githubToken, comment);
    } catch (err) {
      core.warning(`Could not post PR comment: ${err}`);
    }
  } else if (shouldComment) {
    core.info("Skipping PR comment - no GitHub token available.");
  }

  // Final result
  if (totalFailed > 0 && failOnUnexpected) {
    core.setFailed(`${totalFailed} scenario step${totalFailed !== 1 ? "s" : ""} produced unexpected decisions.`);
  } else if (diff?.has_breaking_changes && failOnRegression) {
    // Only tightening fails the build. A loosening is reported loudly but does not
    // block: deliberately relaxing a policy is a normal, intentional change, whereas
    // silently breaking working traffic almost never is.
    core.setFailed(
      `${diff.summary.tightened} call${diff.summary.tightened !== 1 ? "s" : ""} that currently succeed would be blocked by these policy changes. ` +
      `Set fail-on-regression: false if this is intended.`,
    );
  } else {
    core.info(`\nVerdicter CI complete: ${totalPassed}/${totalSteps} steps passed.`);
    if (diff) core.info(`Replayed ${diff.replayed} recorded calls, ${diff.flips.length} verdict change(s).`);
  }
}

run().catch((err) => core.setFailed(String(err)));
