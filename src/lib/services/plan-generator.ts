import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam
} from "openai/resources/chat/completions";
import { getEnv } from "@/lib/env";
import type { QuestionnaireInput } from "@/lib/schemas/questionnaire";
import { trainingPlanJsonSchema, validateTrainingPlan } from "@/lib/schemas/training-plan";
import { parseJsonLenient } from "@/lib/services/llm/json";
import { getLlmClientFromEnv } from "@/lib/services/llm";
import { normalizeLlmError } from "@/lib/services/llm/error-details";
import { buildGenerationMessages } from "@/lib/services/prompt-builder";
import { loadTrainingContext } from "@/lib/services/training-context";
import type { MetricsSnapshot } from "@/lib/services/plan-chat-context";

const MAX_ATTEMPTS = 2;

type PlanGenerationSuccess = {
  planJson: Record<string, unknown>;
  retryCount: number;
};

export class PlanGenerationError extends Error {
  constructor(
    message: string,
    public readonly code: "INVALID_RESPONSE" | "VALIDATION_FAILED" | "LLM_FAILURE",
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export function buildOpenAIRequest(
  model: string,
  messages: ChatCompletionMessageParam[]
): ChatCompletionCreateParamsNonStreaming {
  const request: ChatCompletionCreateParamsNonStreaming & {
    reasoning_effort?: "low";
  } = {
    model,
    messages,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "training_plan",
        strict: true,
        schema: trainingPlanJsonSchema
      }
    }
  };

  if (model === "gpt-5.2") {
    request.reasoning_effort = "low";
  }

  return request;
}

export async function generateTrainingPlan(
  questionnaire: QuestionnaireInput,
  metricsSnapshot?: MetricsSnapshot
): Promise<PlanGenerationSuccess> {
  const env = getEnv();
  const { client, model } = getLlmClientFromEnv();
  const context = await loadTrainingContext(questionnaire.plan_discipline);

  let correctionFeedback: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const messages = buildGenerationMessages({
      trainingContext: context,
      questionnaire,
      metricsSnapshot,
      correctionFeedback
    });

    try {
      const completion = await client.complete({
        model,
        messages,
        mode: {
          kind: "json",
          schemaName: "training_plan",
          schema: trainingPlanJsonSchema as unknown as Record<string, unknown>
        }
      });

      if (!completion.text || completion.text.trim().length === 0) {
        correctionFeedback = JSON.stringify(
          {
            error: "Model response content was empty"
          },
          null,
          2
        );

        if (attempt === MAX_ATTEMPTS) {
          throw new PlanGenerationError("Model response content was empty", "INVALID_RESPONSE");
        }

        continue;
      }

      const parsedJson = parseJsonLenient(completion.text);

      if (!parsedJson.ok) {
        correctionFeedback = JSON.stringify(
          {
            error: parsedJson.error,
            snippet: parsedJson.snippet
          },
          null,
          2
        );

        if (attempt === MAX_ATTEMPTS) {
          throw new PlanGenerationError("Model response was not valid JSON", "INVALID_RESPONSE", {
            error: parsedJson.error,
            snippet: parsedJson.snippet
          });
        }

        continue;
      }

      const validation = validateTrainingPlan(parsedJson.value);

      if (validation.valid) {
        return {
          planJson: parsedJson.value as Record<string, unknown>,
          retryCount: attempt - 1
        };
      }

      correctionFeedback = JSON.stringify(
        {
          errors: validation.errors
        },
        null,
        2
      );

      if (attempt === MAX_ATTEMPTS) {
        throw new PlanGenerationError(
          "Model output failed schema validation after retry",
          "VALIDATION_FAILED",
          validation.errors
        );
      }
    } catch (error) {
      if (error instanceof PlanGenerationError) {
        throw error;
      }
      throw new PlanGenerationError(
        `${env.LLM_PROVIDER === "gemini" ? "Gemini" : "OpenAI"} request failed`,
        "LLM_FAILURE",
        normalizeLlmError(error, `Unknown ${env.LLM_PROVIDER === "gemini" ? "Gemini" : "OpenAI"} error`)
      );
    }
  }

  throw new PlanGenerationError("Unexpected generation failure", "LLM_FAILURE");
}
