import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { jsonError } from "@/lib/api";
import { seedDefaultMetrics } from "@/lib/services/default-metrics";

const signupSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9_-]+$/),
  password: z.string().min(8)
});

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  const parsed = signupSchema.safeParse(payload);

  if (!parsed.success) {
    return jsonError(400, "INVALID_PAYLOAD", "Invalid signup payload", parsed.error.flatten());
  }

  const username = parsed.data.username;
  try {
    const existing = await prisma.user.findUnique({
      where: { username }
    });

    if (existing) {
      return jsonError(409, "USERNAME_TAKEN", "That username is already taken.");
    }

    const passwordHash = await hashPassword(parsed.data.password);

    const user = await prisma.user.create({
      data: {
        username,
        email: null,
        passwordHash
      },
      select: {
        id: true
      }
    });

    await seedDefaultMetrics(user.id).catch(() => {});

    return NextResponse.json({ userId: user.id }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientValidationError) {
      return jsonError(
        500,
        "AUTH_SCHEMA_MISMATCH",
        "Signup is temporarily unavailable due to a database schema mismatch."
      );
    }

    return jsonError(500, "INTERNAL_ERROR", "Unable to create account.");
  }
}
