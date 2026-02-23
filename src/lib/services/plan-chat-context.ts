import type { CompletionSnapshot } from "@/lib/services/plan-completion";
import type { NotesSnapshot } from "@/lib/services/plan-notes";

export type MetricsSnapshot = {
  name: string;
  unit: string;
  latestValue: number;
  recordedAt: string;
}[];

type CompactedMetricsSummary = {
  metrics: {
    name: string;
    value: string;
    recorded: string;
  }[];
  body_weight_kg: number | null;
};

type OnboardingPayload = Record<string, unknown> | null;

type CurrentFocus = {
  week_number: number | null;
  session_number: number | null;
};

type CompactedCompletionSummary = {
  plan_completion_percent: number;
  completed_sessions: number;
  total_sessions: number;
  completed_activities: number;
  total_activities: number;
  current_focus: CurrentFocus;
};

type CompactedSessionNote = {
  week_number: number;
  session_number: number;
  note_text: string;
};

type CompactedActivityNote = {
  week_number: number;
  session_number: number;
  activity_id: string;
  note_text: string;
};

type CompactedNotesSummary = {
  sessions: CompactedSessionNote[];
  activities: CompactedActivityNote[];
};

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function compactText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function completionSort(a: { week_number: number; session_number: number }, b: { week_number: number; session_number: number }): number {
  if (a.week_number !== b.week_number) {
    return a.week_number - b.week_number;
  }

  return a.session_number - b.session_number;
}

export function compactOnboardingContext(onboarding: OnboardingPayload): Record<string, unknown> | null {
  if (!onboarding) {
    return null;
  }

  const targetFocus = onboarding.target_focus;
  const targetFocusSummary =
    typeof targetFocus === "object" && targetFocus !== null && !Array.isArray(targetFocus)
      ? asTrimmedString((targetFocus as Record<string, unknown>).summary)
      : null;
  const targetFocusDate =
    typeof targetFocus === "object" && targetFocus !== null && !Array.isArray(targetFocus)
      ? asTrimmedString((targetFocus as Record<string, unknown>).date)
      : null;

  const trainingHistory = onboarding.training_history_and_load;
  const trainingHistorySummary =
    typeof trainingHistory === "object" && trainingHistory !== null && !Array.isArray(trainingHistory)
      ? asTrimmedString((trainingHistory as Record<string, unknown>).recent_training_summary)
      : null;

  return {
    plan_discipline: asTrimmedString(onboarding.plan_discipline),
    target_focus_summary: targetFocusSummary,
    target_focus_date: targetFocusDate,
    sessions_per_week: typeof onboarding.sessions_per_week === "number" ? onboarding.sessions_per_week : null,
    plan_length_weeks: typeof onboarding.plan_length_weeks === "number" ? onboarding.plan_length_weeks : null,
    current_level_summary: asTrimmedString(onboarding.current_level_summary),
    training_history_summary: trainingHistorySummary,
    injuries_and_constraints: asTrimmedString(onboarding.injuries_and_constraints),
    notes: asTrimmedString(onboarding.notes)
  };
}

export function getCurrentFocus(completion: CompletionSnapshot): CurrentFocus {
  const sessions = [...completion.sessions].sort(completionSort);
  const nextIncomplete = sessions.find((session) => !session.completed);

  if (nextIncomplete) {
    return {
      week_number: nextIncomplete.week_number,
      session_number: nextIncomplete.session_number
    };
  }

  const latest = sessions[sessions.length - 1];
  if (!latest) {
    return {
      week_number: null,
      session_number: null
    };
  }

  return {
    week_number: latest.week_number,
    session_number: latest.session_number
  };
}

export function compactCompletionContext(completion: CompletionSnapshot): CompactedCompletionSummary {
  return {
    plan_completion_percent: completion.plan_completion_percent,
    completed_sessions: completion.completed_sessions,
    total_sessions: completion.total_sessions,
    completed_activities: completion.completed_activities,
    total_activities: completion.total_activities,
    current_focus: getCurrentFocus(completion)
  };
}

function notePriority(currentWeek: number | null, weekNumber: number): number {
  if (currentWeek === null) {
    return 1;
  }

  return weekNumber === currentWeek ? 0 : 1;
}

function byRelevantWeekSessionDesc(
  currentWeek: number | null,
  a: { week_number: number; session_number: number },
  b: { week_number: number; session_number: number }
): number {
  const priorityDelta = notePriority(currentWeek, a.week_number) - notePriority(currentWeek, b.week_number);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  if (a.week_number !== b.week_number) {
    return b.week_number - a.week_number;
  }

  return b.session_number - a.session_number;
}

export function compactNotesContext(notes: NotesSnapshot, completion: CompletionSnapshot): CompactedNotesSummary {
  const currentWeek = getCurrentFocus(completion).week_number;
  const sessionLimit = 8;
  const activityLimit = 12;

  const sessions = [...notes.sessions]
    .sort((a, b) => byRelevantWeekSessionDesc(currentWeek, a, b))
    .slice(0, sessionLimit)
    .map((note) => ({
      ...note,
      note_text: compactText(note.note_text, 280)
    }));

  const activities = [...notes.activities]
    .sort((a, b) => byRelevantWeekSessionDesc(currentWeek, a, b))
    .slice(0, activityLimit)
    .map((note) => ({
      ...note,
      note_text: compactText(note.note_text, 220)
    }));

  return {
    sessions,
    activities
  };
}

export function compactMetricsContext(metricsSnapshot: MetricsSnapshot): CompactedMetricsSummary {
  const bodyWeightEntry = metricsSnapshot.find((m) => m.name === "Body Weight");
  const bodyWeightKg = bodyWeightEntry ? bodyWeightEntry.latestValue : null;

  return {
    metrics: metricsSnapshot.map((m) => ({
      name: m.name,
      value: `${m.latestValue} ${m.unit}`,
      recorded: m.recordedAt
    })),
    body_weight_kg: bodyWeightKg
  };
}
