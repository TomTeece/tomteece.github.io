import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api";
import { requireUserId } from "@/lib/server/auth-guard";

export async function DELETE(
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

    if (metric.isDefault) {
      return jsonError(400, "CANNOT_DELETE_DEFAULT", "Default metrics cannot be deleted.");
    }

    await prisma.metricDefinition.delete({
      where: { id: params.metricId }
    });

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonError(401, "UNAUTHORIZED", "You must be signed in.");
    }
    return jsonError(500, "INTERNAL_ERROR", "Unable to delete metric.");
  }
}
