import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api";
import { requireUserId } from "@/lib/server/auth-guard";
import { seedDefaultMetrics } from "@/lib/services/default-metrics";

const createMetricSchema = z.object({
  name: z.string().trim().min(1).max(100),
  unit: z.string().trim().min(1).max(30),
  description: z.string().trim().max(500).default(""),
  includeBwInPercentage: z.boolean().default(false)
});

export async function GET() {
  try {
    const userId = await requireUserId();

    let definitions = await prisma.metricDefinition.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      include: {
        entries: {
          orderBy: { recordedAt: "desc" },
          take: 1
        }
      }
    });

    if (definitions.length === 0) {
      await seedDefaultMetrics(userId);
      definitions = await prisma.metricDefinition.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        include: {
          entries: {
            orderBy: { recordedAt: "desc" },
            take: 1
          }
        }
      });
    }

    return NextResponse.json({
      metrics: definitions.map((d) => ({
        id: d.id,
        name: d.name,
        unit: d.unit,
        description: d.description,
        isDefault: d.isDefault,
        includeBwInPercentage: d.includeBwInPercentage,
        latestEntry: d.entries[0]
          ? {
              id: d.entries[0].id,
              value: d.entries[0].value,
              recordedAt: d.entries[0].recordedAt.toISOString()
            }
          : null
      }))
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonError(401, "UNAUTHORIZED", "You must be signed in.");
    }
    return jsonError(500, "INTERNAL_ERROR", "Unable to list metrics.");
  }
}

export async function POST(request: Request) {
  try {
    const userId = await requireUserId();
    const payload = await request.json().catch(() => null);
    const parsed = createMetricSchema.safeParse(payload);

    if (!parsed.success) {
      return jsonError(400, "INVALID_PAYLOAD", "Invalid metric data.", parsed.error.flatten());
    }

    const existing = await prisma.metricDefinition.findUnique({
      where: { userId_name: { userId, name: parsed.data.name } }
    });

    if (existing) {
      return jsonError(409, "METRIC_EXISTS", "A metric with that name already exists.");
    }

    const metric = await prisma.metricDefinition.create({
      data: {
        userId,
        name: parsed.data.name,
        unit: parsed.data.unit,
        description: parsed.data.description,
        isDefault: false,
        includeBwInPercentage: parsed.data.includeBwInPercentage
      },
      select: { id: true, name: true, unit: true, description: true, isDefault: true, includeBwInPercentage: true }
    });

    return NextResponse.json({ metric }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonError(401, "UNAUTHORIZED", "You must be signed in.");
    }
    return jsonError(500, "INTERNAL_ERROR", "Unable to create metric.");
  }
}
