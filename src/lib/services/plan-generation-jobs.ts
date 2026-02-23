import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { questionnaireSchema } from "@/lib/schemas/questionnaire";
import { generateTrainingPlan, PlanGenerationError } from "@/lib/services/plan-generator";
import type { MetricsSnapshot } from "@/lib/services/plan-chat-context";

type PlanGenerationJobRecord = {
  id: string;
  userId: string;
  trainingPlanId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  retryCount: number | null;
  resultPlanVersionId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorDetails: unknown;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

export class PlanGenerationJobError extends Error {
  constructor(
    message: string,
    public readonly code: "PLAN_NOT_FOUND" | "QUESTIONNAIRE_REQUIRED" | "INVALID_IDEMPOTENCY_KEY",
    public readonly details?: unknown
  ) {
    super(message);
  }
}

function asJobRecord(job: unknown): PlanGenerationJobRecord {
  return job as PlanGenerationJobRecord;
}

function normalizeError(error: unknown): { errorCode: string; errorMessage: string; errorDetails?: unknown } {
  if (error instanceof PlanGenerationError) {
    return {
      errorCode: `PLAN_${error.code}`,
      errorMessage: error.message,
      errorDetails: error.details
    };
  }

  if (error instanceof z.ZodError) {
    return {
      errorCode: "QUESTIONNAIRE_INVALID",
      errorMessage: "This plan has outdated onboarding data. Open onboarding for this plan and save it again.",
      errorDetails: error.flatten()
    };
  }

  if (error instanceof Error) {
    return {
      errorCode: "INTERNAL_ERROR",
      errorMessage: error.message
    };
  }

  return {
    errorCode: "INTERNAL_ERROR",
    errorMessage: "Unknown error"
  };
}

export async function createOrReusePlanGenerationJob(input: {
  userId: string;
  planId: string;
  idempotencyKey?: string | null;
}): Promise<PlanGenerationJobRecord> {
  const { userId, planId } = input;
  const idempotencyKey = input.idempotencyKey?.trim() ? input.idempotencyKey.trim() : randomUUID();

  if (idempotencyKey.length > 128) {
    throw new PlanGenerationJobError("Idempotency key is too long.", "INVALID_IDEMPOTENCY_KEY", {
      length: idempotencyKey.length
    });
  }

  const plan = await prisma.trainingPlan.findFirst({
    where: {
      id: planId,
      userId,
      deletedAt: null
    },
    select: {
      id: true
    }
  });

  if (!plan) {
    throw new PlanGenerationJobError("Plan not found.", "PLAN_NOT_FOUND");
  }

  const latestQuestionnaire = await prisma.questionnaireResponse.findFirst({
    where: {
      userId,
      trainingPlanId: planId
    } as never,
    orderBy: { createdAt: "desc" },
    select: {
      id: true
    }
  });

  if (!latestQuestionnaire) {
    throw new PlanGenerationJobError(
      "Complete onboarding for this plan before generating.",
      "QUESTIONNAIRE_REQUIRED"
    );
  }

  if (input.idempotencyKey?.trim()) {
    const existing = await prisma.planGenerationJob.findFirst({
      where: {
        userId,
        idempotencyKey
      }
    });

    if (existing) {
      return asJobRecord(existing);
    }
  }

  const active = await prisma.planGenerationJob.findFirst({
    where: {
      userId,
      trainingPlanId: planId,
      status: {
        in: ["queued", "running"]
      }
    },
    orderBy: { createdAt: "desc" }
  });

  if (active) {
    return asJobRecord(active);
  }

  try {
    const created = await prisma.planGenerationJob.create({
      data: {
        userId,
        trainingPlanId: planId,
        questionnaireResponseId: latestQuestionnaire.id,
        idempotencyKey,
        status: "queued"
      }
    });
    return asJobRecord(created);
  } catch (error) {
    const isUniqueViolation =
      (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") ||
      (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002");

    if (isUniqueViolation) {
      const collided = await prisma.planGenerationJob.findFirst({
        where: {
          userId,
          trainingPlanId: planId,
          status: {
            in: ["queued", "running"]
          }
        },
        orderBy: { createdAt: "desc" }
      });

      if (collided) {
        return asJobRecord(collided);
      }
    }

    throw error;
  }
}

export async function processPlanGenerationJob(jobId: string): Promise<void> {
  try {
    const claimed = await prisma.planGenerationJob.updateMany({
      where: {
        id: jobId,
        status: "queued"
      },
      data: {
        status: "running",
        startedAt: new Date()
      }
    });

    if (claimed.count === 0) {
      return;
    }

    const job = await prisma.planGenerationJob.findFirst({
      where: {
        id: jobId
      },
      select: {
        id: true,
        userId: true,
        trainingPlanId: true,
        questionnaireResponse: {
          select: {
            data: true
          }
        }
      }
    });

    if (!job) {
      return;
    }

    const questionnaire = questionnaireSchema.parse(job.questionnaireResponse.data);

    const metricDefinitions = await prisma.metricDefinition.findMany({
      where: { userId: job.userId },
      include: {
        entries: {
          orderBy: { recordedAt: "desc" },
          take: 1
        }
      }
    });

    const metricsSnapshot: MetricsSnapshot = metricDefinitions
      .filter((d: { entries: { value: number; recordedAt: Date }[] }) => d.entries.length > 0)
      .map((d: { name: string; unit: string; entries: { value: number; recordedAt: Date }[] }) => ({
        name: d.name,
        unit: d.unit,
        latestValue: d.entries[0].value,
        recordedAt: d.entries[0].recordedAt.toISOString()
      }));

    const generated = await generateTrainingPlan(questionnaire, metricsSnapshot);

    const planName =
      typeof generated.planJson.plan_name === "string" && generated.planJson.plan_name.length > 0
        ? generated.planJson.plan_name
        : "Generated Climbing Plan";

    const goal = questionnaire.target_focus.summary;
    const finishedAt = new Date();

    await prisma.$transaction(async (tx) => {
      const latestVersion = await tx.trainingPlanVersion.findFirst({
        where: {
          trainingPlanId: job.trainingPlanId
        },
        orderBy: { versionNumber: "desc" },
        select: { versionNumber: true }
      });

      const version = await tx.trainingPlanVersion.create({
        data: {
          trainingPlanId: job.trainingPlanId,
          versionNumber: (latestVersion?.versionNumber ?? 0) + 1,
          planJson: generated.planJson as Prisma.InputJsonValue
        },
        select: {
          id: true
        }
      });

      await tx.trainingPlan.update({
        where: {
          id: job.trainingPlanId
        },
        data: {
          name: planName,
          goal,
          currentPlanVersionId: version.id
        }
      });

      await tx.planGenerationJob.update({
        where: {
          id: job.id
        },
        data: {
          status: "succeeded",
          resultPlanVersionId: version.id,
          retryCount: generated.retryCount,
          finishedAt
        }
      });
    });
  } catch (error) {
    const finishedAt = new Date();
    const normalized = normalizeError(error);

    try {
      await prisma.planGenerationJob.update({
        where: {
          id: jobId
        },
        data: {
          status: "failed",
          errorCode: normalized.errorCode,
          errorMessage: normalized.errorMessage,
          errorDetails: normalized.errorDetails as Prisma.InputJsonValue,
          finishedAt
        }
      });
    } catch (updateError) {
      console.error("Unable to mark plan generation job failed", updateError);
    }

    // Log raw error for deep debugging (network/provider/runtime failures).
    console.error("Plan generation job raw error", error);
    console.error("Plan generation job failure", normalized);
  }
}
