import { getEnv } from "@/lib/env";
import { getLlmClientFromEnv } from "@/lib/services/llm";
import { normalizeLlmError } from "@/lib/services/llm/error-details";
import type { LlmMessage } from "@/lib/services/llm/types";
import type { CompletionSnapshot } from "@/lib/services/plan-completion";
import type { NotesSnapshot } from "@/lib/services/plan-notes";
import {
  compactCompletionContext,
  compactMetricsContext,
  compactNotesContext,
  compactOnboardingContext
} from "@/lib/services/plan-chat-context";
import type { MetricsSnapshot } from "@/lib/services/plan-chat-context";
import {
  loadTrainingContext,
  resolvePlanDiscipline
} from "@/lib/services/training-context";

type PlanChatHistoryItem = {
  role: "user" | "assistant";
  content: string;
};

type GeneratePlanChatReplyInput = {
  onboarding: Record<string, unknown> | null;
  planJson: Record<string, unknown>;
  completion: CompletionSnapshot;
  notes: NotesSnapshot;
  metricsSnapshot: MetricsSnapshot;
  history: PlanChatHistoryItem[];
  userMessage: string;
};

export class PlanChatError extends Error {
  constructor(
    message: string,
    public readonly code: "INVALID_RESPONSE" | "LLM_FAILURE",
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export function buildPlanChatMessages(params: {
  trainingContext: string;
  onboarding: Record<string, unknown> | null;
  planJson: Record<string, unknown>;
  completion: CompletionSnapshot;
  notes: NotesSnapshot;
  metricsSnapshot: MetricsSnapshot;
  history: PlanChatHistoryItem[];
  userMessage: string;
}): LlmMessage[] {
  const onboardingContext = compactOnboardingContext(params.onboarding);
  const onboardingSummary = onboardingContext
    ? JSON.stringify(onboardingContext, null, 2)
    : "No onboarding response saved yet for this plan. Ask concise clarifying questions when needed.";
  const completionSummary = JSON.stringify(compactCompletionContext(params.completion), null, 2);
  const notesSummary = JSON.stringify(compactNotesContext(params.notes, params.completion), null, 2);
  const metricsSummary =
    params.metricsSnapshot.length > 0
      ? JSON.stringify(compactMetricsContext(params.metricsSnapshot), null, 2)
      : "No progress metrics recorded yet.";

  const messages: LlmMessage[] = [
    {
      role: "system",
      content: params.trainingContext
    },
    {
      role: "system",
      content:
        "You are discussing the user's plan. Do not mutate plan data. Be a practical, supportive coach and tailor advice to current adherence and notes."
    },
    {
      role: "system",
      content:
        "Response format: 1) Brief assessment (1-2 sentences anchored to current plan/adherence facts) 2) Next session adjustments (numbered, concrete prescriptions with dosage/intensity/rest details and explicit week/session references when available) 3) Safety/constraint callouts (if relevant). Keep it concise and actionable. Avoid generic motivational filler."
    },
    {
      role: "system",
      content: `Onboarding context:\n${onboardingSummary}`
    },
    {
      role: "system",
      content: `Completion context:\n${completionSummary}`
    },
    {
      role: "system",
      content: `Notes context:\n${notesSummary}`
    },
    {
      role: "system",
      content: `Progress metrics (latest recorded values):\n${metricsSummary}`
    },
    {
      role: "system",
      content: `Current plan JSON:\n${JSON.stringify(params.planJson, null, 2)}`
    }
  ];

  for (const item of params.history) {
    messages.push({
      role: item.role,
      content: item.content
    });
  }

  messages.push({
    role: "user",
    content: params.userMessage
  });

  return messages;
}

export async function generatePlanChatReply(input: GeneratePlanChatReplyInput): Promise<string> {
  const env = getEnv();
  const { client, model } = getLlmClientFromEnv();
  const discipline = resolvePlanDiscipline({
    onboarding: input.onboarding,
    planJson: input.planJson
  });
  const context = await loadTrainingContext(discipline);

  const messages = buildPlanChatMessages({
    trainingContext: context,
    onboarding: input.onboarding,
    planJson: input.planJson,
    completion: input.completion,
    notes: input.notes,
    metricsSnapshot: input.metricsSnapshot,
    history: input.history,
    userMessage: input.userMessage
  });

  try {
    const completion = await client.complete({
      model,
      messages,
      mode: { kind: "text" }
    });

    const content = completion.text;

    if (!content || content.trim().length === 0) {
      throw new PlanChatError("Model response content was empty", "INVALID_RESPONSE");
    }

    return content;
  } catch (error) {
    if (error instanceof PlanChatError) {
      throw error;
    }

    throw new PlanChatError(
      `${env.LLM_PROVIDER === "gemini" ? "Gemini" : "OpenAI"} request failed`,
      "LLM_FAILURE",
      normalizeLlmError(error, `Unknown ${env.LLM_PROVIDER === "gemini" ? "Gemini" : "OpenAI"} error`)
    );
  }
}

export async function* streamPlanChatReply(
  input: GeneratePlanChatReplyInput,
  options?: { signal?: AbortSignal }
): AsyncIterable<string> {
  const env = getEnv();
  const { client, model } = getLlmClientFromEnv();
  const discipline = resolvePlanDiscipline({
    onboarding: input.onboarding,
    planJson: input.planJson
  });
  const context = await loadTrainingContext(discipline);

  const messages = buildPlanChatMessages({
    trainingContext: context,
    onboarding: input.onboarding,
    planJson: input.planJson,
    completion: input.completion,
    notes: input.notes,
    metricsSnapshot: input.metricsSnapshot,
    history: input.history,
    userMessage: input.userMessage
  });

  try {
    if (!client.completeStream) {
      const completion = await client.complete({
        model,
        messages,
        mode: { kind: "text" }
      });
      if (completion.text) {
        yield completion.text;
      }
      return;
    }

    yield* client.completeStream({
      model,
      messages,
      mode: { kind: "text" },
      ...(options?.signal ? { signal: options.signal } : {})
    });
  } catch (error) {
    throw new PlanChatError(
      `${env.LLM_PROVIDER === "gemini" ? "Gemini" : "OpenAI"} request failed`,
      "LLM_FAILURE",
      normalizeLlmError(error, `Unknown ${env.LLM_PROVIDER === "gemini" ? "Gemini" : "OpenAI"} error`)
    );
  }
}
