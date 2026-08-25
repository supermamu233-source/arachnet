import { requireAuthContext } from "@/server/auth/session";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export default async function DashboardPage() {
  const context = await requireAuthContext();
  const orgWhere = { organizationId: context.organizationId };

  const [
    openDiscrepancies,
    criticalDiscrepancies,
    countsToday,
    pendingIntakes,
    unverifiedExpected,
    robots,
    recentAudit,
  ] = await Promise.all([
    prisma.inventoryDiscrepancy.count({
      where: { ...orgWhere, status: { in: ["SHORTAGE", "SURPLUS", "REVIEW_REQUIRED", "EXPECTED_MISSING"] } },
    }),
    prisma.inventoryDiscrepancy.count({
      where: { ...orgWhere, severity: "CRITICAL", status: { notIn: ["RESOLVED", "DISMISSED"] } },
    }),
    prisma.inventoryCount.count({ where: { ...orgWhere, capturedAt: { gte: startOfToday() } } }),
    prisma.productIntake.count({ where: { ...orgWhere, status: "READY_FOR_REVIEW" } }),
    prisma.inventoryDiscrepancy.count({ where: { ...orgWhere, status: "PHYSICAL_UNVERIFIED" } }),
    prisma.robotDevice.findMany({ where: orgWhere, select: { name: true, status: true, lastSeenAt: true } }),
    prisma.auditLog.findMany({
      where: orgWhere,
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { action: true, entityType: true, createdAt: true },
    }),
  ]);

  const stats = [
    { label: "Discrepancias abiertas", value: openDiscrepancies },
    { label: "Discrepancias críticas", value: criticalDiscrepancies },
    { label: "Conteos hoy", value: countsToday },
    { label: "Altas de producto pendientes", value: pendingIntakes },
    { label: "Stock esperado sin verificar", value: unverifiedExpected },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Panel</h1>
        <p className="text-sm text-muted-foreground">Resumen del estado físico del almacén.</p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{stat.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold text-foreground">{stat.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Estado de robots</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {robots.length === 0 && (
              <p className="text-sm text-muted-foreground">No hay robots registrados.</p>
            )}
            {robots.map((robot) => (
              <div key={robot.name} className="flex items-center justify-between text-sm">
                <span className="text-foreground">{robot.name}</span>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">
                    {robot.lastSeenAt ? robot.lastSeenAt.toLocaleString("es-ES") : "Nunca visto"}
                  </span>
                  <Badge variant={robot.status === "ACTIVE" ? "default" : "secondary"}>
                    {robot.status === "ACTIVE" ? "Activo" : "Desactivado"}
                  </Badge>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Actividad reciente</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {recentAudit.length === 0 && (
              <p className="text-sm text-muted-foreground">Aún no hay actividad registrada.</p>
            )}
            {recentAudit.map((entry, index) => (
              <div key={index} className="flex items-center justify-between text-sm">
                <span className="text-foreground">
                  {entry.action} · {entry.entityType}
                </span>
                <span className="text-muted-foreground">{entry.createdAt.toLocaleString("es-ES")}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
