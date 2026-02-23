import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api";
import { requireUserId } from "@/lib/server/auth-guard";

export async function DELETE(
  _request: Request,
  { params }: { params: { metricId: string; entryId: string } }
) {
  try {
    const userId = await requireUserId();

    const entry = await prisma.metricEntry.findUnique({
      where: { id: params.entryId }
    });

    if (!entry || entry.userId !== userId || entry.metricDefinitionId !== params.metricId) {
      return jsonError(404, "NOT_FOUND", "Entry not found.");
    }

    await prisma.metricEntry.delete({
      where: { id: params.entryId }
    });

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonError(401, "UNAUTHORIZED", "You must be signed in.");
    }
    return jsonError(500, "INTERNAL_ERROR", "Unable to delete entry.");
  }
}
