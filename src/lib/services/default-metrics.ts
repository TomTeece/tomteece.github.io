import { prisma } from "@/lib/prisma";

export const DEFAULT_METRICS = [
  {
    name: "Body Weight",
    unit: "kg",
    description: "Body weight in kilograms",
    includeBwInPercentage: false
  },
  {
    name: "Finger Strength",
    unit: "kg",
    description:
      "The total amount of weight added to or subtracted from body weight when hanging from a 20mm edge for 7 seconds",
    includeBwInPercentage: true
  },
  {
    name: "Weighted Pull-ups",
    unit: "kg",
    description:
      "The total amount of weight added to or subtracted from body weight when performing a single pull-up",
    includeBwInPercentage: true
  }
] as const;

export async function seedDefaultMetrics(userId: string): Promise<void> {
  await prisma.metricDefinition.createMany({
    data: DEFAULT_METRICS.map((m) => ({
      userId,
      name: m.name,
      unit: m.unit,
      description: m.description,
      isDefault: true,
      includeBwInPercentage: m.includeBwInPercentage
    })),
    skipDuplicates: true
  });
}
