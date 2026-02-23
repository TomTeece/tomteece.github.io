import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api";
import { requireUserId } from "@/lib/server/auth-guard";
import { PlanChatError, generatePlanChatReply, streamPlanChatReply } from "@/lib/services/plan-chat";
import { getCompletionSnapshot } from "@/lib/services/plan-completion";
import { getNotesSnapshot } from "@/lib/services/plan-notes";
import type { MetricsSnapshot } from "@/lib/services/plan-chat-context";

async function getMetricsSnapshot(userId: string): Promise<MetricsSnapshot> {
  const definitions = await prisma.metricDefinition.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    include: {
      entries: {
        orderBy: { recordedAt: "desc" },
        take: 1
      }
    }
  });

  return definitions
    .filter((d) => d.entries.length > 0)
    .map((d) => ({
      name: d.name,
      unit: d.unit,
      latestValue: d.entries[0].value,
      recordedAt: d.entries[0].recordedAt.toISOString()
    }));
}

const postSchema = z.object({
  content: z.string().min(1).max(4000),
  sourceTweakRequestId: z.string().cuid().optional()
});

export async function GET(
  _request: Request,
  context: {
    params: { planId: string; threadId: string };
  }
) {
  try {
    const userId = await requireUserId();

    const thread = await prisma.planChatThread.findFirst({
      where: {
        id: context.params.threadId,
        trainingPlanId: context.params.planId,
        userId,
        trainingPlan: {
          deletedAt: null
        }
      },
      select: {
        id: true
      }
    });

    if (!thread) {
      return jsonError(404, "NOT_FOUND", "Chat thread not found.");
    }

    const messages = await prisma.planChatMessage.findMany({
      where: {
        threadId: thread.id
      },
      orderBy: {
        createdAt: "asc"
      },
      select: {
        id: true,
        role: true,
        content: true,
        sourceTweakRequestId: true,
        createdAt: true
      }
    });

    return NextResponse.json({
      messages: messages.map((message) => ({
        ...message,
        createdAt: message.createdAt.toISOString()
      }))
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonError(401, "UNAUTHORIZED", "You must be signed in.");
    }

    return jsonError(500, "INTERNAL_ERROR", "Unable to list chat messages.");
  }
}

export async function POST(
  request: Request,
  context: {
    params: { planId: string; threadId: string };
  }
) {
  try {
    const wantsStream =
      request.headers.get("accept")?.includes("text/event-stream") ||
      new URL(request.url).searchParams.get("stream") === "1";
    const userId = await requireUserId();
    const payload = await request.json().catch(() => null);
    const parsed = postSchema.safeParse(payload);

    if (!parsed.success) {
      return jsonError(400, "INVALID_PAYLOAD", "Invalid chat message payload.", parsed.error.flatten());
    }

    const thread = await prisma.planChatThread.findFirst({
      where: {
        id: context.params.threadId,
        trainingPlanId: context.params.planId,
        userId,
        trainingPlan: {
          deletedAt: null
        }
      },
      select: {
        id: true,
        trainingPlanId: true,
        planVersionId: true,
        planVersion: {
          select: {
            planJson: true
          }
        }
      }
    });

    if (!thread) {
      return jsonError(404, "NOT_FOUND", "Chat thread not found.");
    }

    if (parsed.data.sourceTweakRequestId) {
      const tweak = await prisma.planTweakRequest.findFirst({
        where: {
          id: parsed.data.sourceTweakRequestId,
          trainingPlanId: thread.trainingPlanId,
          userId
        },
        select: {
          id: true
        }
      });

      if (!tweak) {
        return jsonError(404, "NOT_FOUND", "Referenced tweak request not found.");
      }
    }

    const history = await prisma.planChatMessage.findMany({
      where: {
        threadId: thread.id
      },
      orderBy: {
        createdAt: "asc"
      },
      select: {
        role: true,
        content: true
      }
    });

    const latestQuestionnaire = await prisma.questionnaireResponse.findFirst({
      where: {
        userId,
        trainingPlanId: thread.trainingPlanId
      } as never,
      orderBy: { createdAt: "desc" },
      select: {
        data: true
      }
    });

    const [completion, notes, metricsSnapshot] = await Promise.all([
      getCompletionSnapshot({
        userId,
        trainingPlanId: thread.trainingPlanId,
        planVersionId: thread.planVersionId,
        planJson: thread.planVersion.planJson as Record<string, unknown>
      }),
      getNotesSnapshot({
        userId,
        trainingPlanId: thread.trainingPlanId,
        planVersionId: thread.planVersionId
      }),
      getMetricsSnapshot(userId)
    ]);

    if (wantsStream) {
      const encoder = new TextEncoder();

      const sseEvent = (event: string, data: unknown) => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        return encoder.encode(payload);
      };

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          void (async () => {
            try {
              const userMessage = await prisma.planChatMessage.create({
                data: {
                  threadId: thread.id,
                  role: "user",
                  content: parsed.data.content,
                  sourceTweakRequestId: parsed.data.sourceTweakRequestId
                },
                select: {
                  id: true,
                  role: true,
                  content: true,
                  sourceTweakRequestId: true,
                  createdAt: true
                }
              });

              await prisma.planChatThread.update({
                where: { id: thread.id },
                data: { updatedAt: new Date() }
              });

              controller.enqueue(
                sseEvent("user_message", {
                  ...userMessage,
                  createdAt: userMessage.createdAt.toISOString()
                })
              );

              let assistantContent = "";

              for await (const delta of streamPlanChatReply(
                {
                  onboarding: (latestQuestionnaire?.data as Record<string, unknown> | null) ?? null,
                  planJson: thread.planVersion.planJson as Record<string, unknown>,
                  completion,
                  notes,
                  metricsSnapshot,
                  history: history.map((item) => ({
                    role: item.role,
                    content: item.content
                  })),
                  userMessage: parsed.data.content
                },
                { signal: request.signal }
              )) {
                if (request.signal.aborted) {
                  break;
                }

                assistantContent += delta;
                controller.enqueue(sseEvent("assistant_delta", { delta }));
              }

              if (request.signal.aborted) {
                controller.close();
                return;
              }

              if (!assistantContent || assistantContent.trim().length === 0) {
                // Fallback: if streaming produced no text (e.g. SSE parsing mismatch),
                // try the non-streaming path once before surfacing INVALID_RESPONSE.
                assistantContent = await generatePlanChatReply({
                  onboarding: (latestQuestionnaire?.data as Record<string, unknown> | null) ?? null,
                  planJson: thread.planVersion.planJson as Record<string, unknown>,
                  completion,
                  notes,
                  metricsSnapshot,
                  history: history.map((item) => ({
                    role: item.role,
                    content: item.content
                  })),
                  userMessage: parsed.data.content
                });
              }

              if (!assistantContent || assistantContent.trim().length === 0) {
                throw new PlanChatError("Model response content was empty", "INVALID_RESPONSE");
              }

              const assistantMessage = await prisma.$transaction(async (tx) => {
                const created = await tx.planChatMessage.create({
                  data: {
                    threadId: thread.id,
                    role: "assistant",
                    content: assistantContent
                  },
                  select: {
                    id: true,
                    role: true,
                    content: true,
                    sourceTweakRequestId: true,
                    createdAt: true
                  }
                });

                await tx.planChatThread.update({
                  where: { id: thread.id },
                  data: { updatedAt: new Date() }
                });

                return created;
              });

              controller.enqueue(
                sseEvent("assistant_message", {
                  ...assistantMessage,
                  createdAt: assistantMessage.createdAt.toISOString()
                })
              );
              controller.enqueue(sseEvent("done", { ok: true }));
              controller.close();
            } catch (error) {
              const message =
                error instanceof PlanChatError
                  ? error.code === "INVALID_RESPONSE"
                    ? "Model returned an invalid chat response."
                    : "Chat request failed."
                  : "Unable to create chat messages.";

              controller.enqueue(sseEvent("error", { message }));
              controller.close();
            }
          })();
        }
      });

      return new NextResponse(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive"
        }
      });
    }

    const assistantContent = await generatePlanChatReply({
      onboarding: (latestQuestionnaire?.data as Record<string, unknown> | null) ?? null,
      planJson: thread.planVersion.planJson as Record<string, unknown>,
      completion,
      notes,
      metricsSnapshot,
      history: history.map((item) => ({
        role: item.role,
        content: item.content
      })),
      userMessage: parsed.data.content
    });

    const result = await prisma.$transaction(async (tx) => {
      const userMessage = await tx.planChatMessage.create({
        data: {
          threadId: thread.id,
          role: "user",
          content: parsed.data.content,
          sourceTweakRequestId: parsed.data.sourceTweakRequestId
        },
        select: {
          id: true,
          role: true,
          content: true,
          sourceTweakRequestId: true,
          createdAt: true
        }
      });

      const assistantMessage = await tx.planChatMessage.create({
        data: {
          threadId: thread.id,
          role: "assistant",
          content: assistantContent
        },
        select: {
          id: true,
          role: true,
          content: true,
          sourceTweakRequestId: true,
          createdAt: true
        }
      });

      await tx.planChatThread.update({
        where: {
          id: thread.id
        },
        data: {
          updatedAt: new Date()
        }
      });

      return {
        userMessage,
        assistantMessage
      };
    });

    return NextResponse.json(
      {
        userMessage: {
          ...result.userMessage,
          createdAt: result.userMessage.createdAt.toISOString()
        },
        assistantMessage: {
          ...result.assistantMessage,
          createdAt: result.assistantMessage.createdAt.toISOString()
        }
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonError(401, "UNAUTHORIZED", "You must be signed in.");
    }

    if (error instanceof PlanChatError) {
      if (error.code === "INVALID_RESPONSE") {
        return jsonError(502, "CHAT_INVALID_RESPONSE", "Model returned an invalid chat response.", error.details);
      }

      return jsonError(502, "CHAT_LLM_FAILURE", "Chat request failed.", error.details);
    }

    return jsonError(500, "INTERNAL_ERROR", "Unable to create chat messages.");
  }
}
