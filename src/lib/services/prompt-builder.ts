import type { QuestionnaireInput } from "@/lib/schemas/questionnaire";
import type { LlmMessage } from "@/lib/services/llm/types";
import type { MetricsSnapshot } from "@/lib/services/plan-chat-context";
import { compactMetricsContext } from "@/lib/services/plan-chat-context";

const COACHING_CONSTRAINTS = [
  "You are a conservative climbing coach.",
  "Return JSON only and match the schema exactly (no markdown, no extra text).",
  "Use session_number plans; do not assume weekdays.",
  "Respect injuries/constraints; keep loads realistic; use only the user's stated facilities/equipment.",
  "Every session includes Warm-up and Cool-down.",
  "Every session includes Conditioning/Strength (if needed, use a 5-10 min minimal-dose accessory).",
  "Each week includes climbing in at least 3 sessions when 3+ sessions exist; if <3 sessions, every session includes climbing.",
  "Include executive_summary with exactly two text sections in this order: phase_by_phase_weekly_split then program_snapshot.",
  "phase_by_phase_weekly_split must be a concise plain-text breakdown (multi-line text is allowed).",
  "program_snapshot must be a concise plain-text summary (multi-line text is allowed).",
  "Order: hangboard before climbing; power-endurance before sustained route-sim when both exist.",
  "Week focus must state adaptation target + progression intent.",
  "Write concrete prescriptions: objective + workload + intensity cue + dosage + rest + stop/scale rule.",
  "Use null (not empty strings) for optional fields like intensity/completion_criteria when unknown.",
  "Use unique, stable activity_id values (prefer w{week}_s{session}_a{index})."
].join(" ");

export function buildGenerationMessages(params: {
  trainingContext: string;
  questionnaire: QuestionnaireInput;
  metricsSnapshot?: MetricsSnapshot;
  correctionFeedback?: string;
}): LlmMessage[] {
  const { age, ...questionnaireWithoutAge } = params.questionnaire;
  const promptQuestionnaire = {
    ...questionnaireWithoutAge,
    climbing_age_years: age
  };

  const metricsContext =
    params.metricsSnapshot && params.metricsSnapshot.length > 0
      ? JSON.stringify(compactMetricsContext(params.metricsSnapshot), null, 2)
      : null;

  const baseMessages: LlmMessage[] = [
    {
      role: "system",
      content: params.trainingContext
    },
    {
      role: "system",
      content: COACHING_CONSTRAINTS
    },
    ...(metricsContext
      ? [
          {
            role: "system" as const,
            content: `Progress metrics (latest recorded values):\n${metricsContext}`
          }
        ]
      : []),
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "Generate a personalized climbing training plan.",
          questionnaire: promptQuestionnaire
        },
        null,
        2
      )
    }
  ];

  if (!params.correctionFeedback) {
    return baseMessages;
  }

  return [
    ...baseMessages,
    {
      role: "user",
      content: `The previous output failed schema validation. Fix it exactly:\n${params.correctionFeedback}`
    }
  ];
}
