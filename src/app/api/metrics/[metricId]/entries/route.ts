import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api";
import { requireUserId } from "@/lib/server/auth-guard";

const addEntrySchema = z.object({
  value: z.number(),
  recordedAt: z.string().datetime().optional()
});

export async function GET(
  _request: Request,
  { params }: { params: { metricId: string } }
) {
  try {
    const userId = await requireUserId();

    const metric = await prisma.metricDefinition.findUnique({
      where: { id: params.metricId }
    });

    if (!metric || metric.userId !== userId) {
      return jsonError(404, "NOT_FOUND", "Metric not found.");
    }

    const entries = await prisma.metricEntry.findMany({
      where: { metricDefinitionId: params.metricId, userId },
      orderBy: { recordedAt: "desc" },
      take: 50
    });

    return NextResponse.json({
      entries: entries.map((e) => ({
        id: e.id,
        value: e.value,
        recordedAt: e.recordedAt.toISOString()
      }))
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonError(401, "UNAUTHORIZED", "You must be signed in.");
    }
    return jsonError(500, "INTERNAL_ERROR", "Unable to list entries.");
  }
}

export async function POST(
  request: Request,
  { params }: { params: { metricId: string } }
) {
  try {
    const userId = await requireUserId();
    const payload = await request.json().catch(() => null);
    const parsed = addEntrySchema.safeParse(payload);

    if (!parsed.success) {
      return jsonError(400, "INVALID_PAYLOAD", "Invalid entry data.", parsed.error.flatten());
    }

    const metric = await prisma.metricDefinition.findUnique({
      where: { id: params.metricId }
    });

    if (!metric || metric.userId !== userId) {
      return jsonError(404, "NOT_FOUND", "Metric not found.");
    }

    const entry = await prisma.metricEntry.create({
      data: {
        userId,
        metricDefinitionId: params.metricId,
        value: parsed.data.value,
        recordedAt: parsed.data.recordedAt ? new Date(parsed.data.recordedAt) : new Date()
      },
      select: { id: true, value: true, recordedAt: true }
    });

    return NextResponse.json(
      {
        entry: {
          id: entry.id,
          value: entry.value,
          recordedAt: entry.recordedAt.toISOString()
        }
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonError(401, "UNAUTHORIZED", "You must be signed in.");
    }
    return jsonError(500, "INTERNAL_ERROR", "Unable to add entry.");
  }
}
