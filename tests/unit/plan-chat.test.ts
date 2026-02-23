import { describe, expect, it } from "vitest";
import { buildPlanChatMessages } from "@/lib/services/plan-chat";

describe("plan-chat service", () => {
  it("builds chat messages with onboarding, completion, notes, plan JSON, and history", () => {
    const messages = buildPlanChatMessages({
      trainingContext: "TRAINING_CONTEXT",
      onboarding: {
        sessions_per_week: 3
      },
      planJson: {
        plan_name: "Test",
        start_date: "2026-02-15",
        weeks: []
      },
      completion: {
        plan_completion_percent: 25,
        completed_sessions: 1,
        total_sessions: 4,
        completed_activities: 2,
        total_activities: 8,
        sessions: [],
        activities: []
      },
      notes: {
        sessions: [],
        activities: []
      },
      metricsSnapshot: [
        { name: "Body Weight", unit: "kg", latestValue: 72, recordedAt: "2026-02-20T00:00:00.000Z" },
        { name: "Finger Strength", unit: "kg", latestValue: 25, recordedAt: "2026-02-20T00:00:00.000Z" }
      ],
      history: [
        {
          role: "user",
          content: "How should I pace this week?"
        },
        {
          role: "assistant",
          content: "Keep intensity moderate in session 1."
        }
      ],
      userMessage: "What if my finger feels sore?"
    });

    expect(messages[0]).toEqual({
      role: "system",
      content: "TRAINING_CONTEXT"
    });
    expect(messages[1]?.role).toBe("system");
    expect(messages[2]?.role).toBe("system");
    expect(messages[3]?.role).toBe("system");
    expect(messages[4]?.role).toBe("system");
    expect(messages[5]?.role).toBe("system");
    expect(messages[6]?.role).toBe("system");
    expect(messages[7]?.role).toBe("system");
    expect(messages[8]).toEqual({
      role: "user",
      content: "How should I pace this week?"
    });
    expect(messages[9]).toEqual({
      role: "assistant",
      content: "Keep intensity moderate in session 1."
    });
    expect(messages[10]).toEqual({
      role: "user",
      content: "What if my finger feels sore?"
    });

    const onboardingContext = messages[3]?.content;
    expect(typeof onboardingContext).toBe("string");
    expect(onboardingContext as string).toContain("target_focus_summary");
    expect(onboardingContext as string).not.toContain("age");

    const completionContext = messages[4]?.content;
    expect(typeof completionContext).toBe("string");
    expect(completionContext as string).toContain("current_focus");
    expect(completionContext as string).not.toContain("\"sessions\":");

    const notesContext = messages[5]?.content;
    expect(typeof notesContext).toBe("string");
    expect(notesContext as string).toContain("\"sessions\":");
    expect(notesContext as string).not.toContain("session_notes");

    const metricsContext = messages[6]?.content;
    expect(typeof metricsContext).toBe("string");
    expect(metricsContext as string).toContain("Body Weight");
    expect(metricsContext as string).toContain("Finger Strength");
    expect(metricsContext as string).toContain("body_weight_kg");

    const coachingGuidance = messages[2]?.content;
    expect(typeof coachingGuidance).toBe("string");
    expect((coachingGuidance as string).toLowerCase()).toContain("brief assessment");
  });
});
