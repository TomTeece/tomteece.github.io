import Link from "next/link";
import type { Metadata } from "next";
import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CreatePlanButton } from "@/components/create-plan-button";
import { GeneratePlanButton } from "@/components/generate-plan-button";
import { DeletePlanButton } from "@/components/delete-plan-button";
import { MetricsPanel } from "@/components/metrics-panel";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false
  }
};

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;

  if (!userId) {
    redirect("/login");
  }

  const plans = await prisma.trainingPlan.findMany({
    where: { userId, deletedAt: null },
    orderBy: { updatedAt: "desc" },
    include: {
      currentPlanVersion: {
        select: {
          id: true,
          createdAt: true
        }
      }
    }
  });
  const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  });

  return (
    <>
      <section className="card dashboard-hero">
        <h1>Dashboard</h1>
        <p>Build your next block, track progress, and adjust sessions with coach chat support.</p>
        <div className="dashboard-actions">
          <CreatePlanButton />
        </div>
      </section>

      <section className="card dashboard-list-card">
        <h2>Your Plans</h2>
        {plans.length === 0 ? (
          <p>No plans yet. Create your first plan to begin.</p>
        ) : (
          <ul className="plan-list">
            {plans.map((plan) => (
              <li key={plan.id} className="plan-list-item">
                <div className="plan-list-header">
                  <div>
                    <p className="plan-list-name">{plan.name}</p>
                    <p className="plan-meta">Updated {dateTimeFormatter.format(plan.updatedAt)}</p>
                  </div>
                  <span
                    className={`plan-status ${
                      plan.currentPlanVersionId ? "plan-status-generated" : "plan-status-draft"
                    }`}
                  >
                    {plan.currentPlanVersionId ? "Written" : "Draft"}
                  </span>
                </div>
                <div className="link-row">
                  {plan.currentPlanVersionId ? (
                    <Link className="plan-open-cta" href={`/plans/${plan.id}`}>
                      Open plan
                    </Link>
                  ) : null}
                  <Link href={`/onboarding?planId=${plan.id}`}>Onboarding</Link>
                  {!plan.currentPlanVersionId ? <GeneratePlanButton planId={plan.id} label="Write plan" /> : null}
                  <DeletePlanButton planId={plan.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <MetricsPanel />
    </>
  );
}
