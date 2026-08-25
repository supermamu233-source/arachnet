import { redirect } from "next/navigation";
import { getAuthContext } from "@/server/auth/session";
import { prisma } from "@/lib/prisma";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { DashboardTopbar } from "@/components/dashboard/topbar";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: context.organizationId },
    select: { name: true },
  });

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <DashboardSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <DashboardTopbar organizationName={organization.name} userName={context.name} role={context.role} />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
