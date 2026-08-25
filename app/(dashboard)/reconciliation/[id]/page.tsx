import { notFound } from "next/navigation";
import { requireAuthContext } from "@/server/auth/session";
import { getDiscrepancy } from "@/server/services/reconciliation";
import { roleSatisfies } from "@/server/permissions/rbac";
import { ApiError } from "@/lib/errors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ResolutionActions } from "@/components/reconciliation/resolution-actions";

export default async function DiscrepancyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await requireAuthContext();

  let discrepancy;
  try {
    discrepancy = await getDiscrepancy(context.organizationId, id);
  } catch (error) {
    if (error instanceof ApiError && (error.code === "NOT_FOUND" || error.code === "ORGANIZATION_MISMATCH")) {
      notFound();
    }
    throw error;
  }

  const isOpen = !["RESOLVED", "DISMISSED"].includes(discrepancy.status);
  const canDismiss = roleSatisfies(context.role, "MANAGER");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{discrepancy.product.name}</h1>
        <p className="text-sm text-muted-foreground">
          {discrepancy.product.sku} · {discrepancy.location.code}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Esperado</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{discrepancy.expectedQuantity ?? "—"}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Observado</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{discrepancy.observedQuantity ?? "—"}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Diferencia</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{discrepancy.difference ?? "—"}</CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-2">
        {discrepancy.severity && <Badge variant="destructive">{discrepancy.severity}</Badge>}
        <Badge variant="secondary">{discrepancy.status}</Badge>
        <span className="text-sm text-muted-foreground">
          Visto por última vez {discrepancy.lastSeenAt.toLocaleString("es-ES")}
        </span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Evidencia</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {discrepancy.latestCount && (
            <p>
              Último conteo por {discrepancy.latestCount.createdBy.name} el{" "}
              {discrepancy.latestCount.capturedAt.toLocaleString("es-ES")} ({discrepancy.latestCount.evidence.length}{" "}
              imágenes)
            </p>
          )}
          {discrepancy.latestRobotObservation && (
            <p>
              Última observación de robot ({discrepancy.latestRobotObservation.robot.name}) el{" "}
              {discrepancy.latestRobotObservation.capturedAt.toLocaleString("es-ES")} — confianza{" "}
              {discrepancy.latestRobotObservation.confidenceLevel}
            </p>
          )}
          {!discrepancy.latestCount && !discrepancy.latestRobotObservation && (
            <p className="text-muted-foreground">Sin observación física registrada.</p>
          )}
        </CardContent>
      </Card>

      {isOpen && (
        <Card>
          <CardHeader>
            <CardTitle>Resolver discrepancia</CardTitle>
          </CardHeader>
          <CardContent>
            <ResolutionActions discrepancyId={discrepancy.id} canDismiss={canDismiss} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Historial de resolución</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {discrepancy.resolutions.length === 0 && (
            <p className="text-sm text-muted-foreground">Sin historial todavía.</p>
          )}
          {discrepancy.resolutions.map((event, index) => (
            <div key={event.id}>
              {index > 0 && <Separator className="mb-3" />}
              <p className="text-sm text-foreground">{event.action}</p>
              {event.notes && <p className="text-sm text-muted-foreground">{event.notes}</p>}
              <p className="text-xs text-muted-foreground">{event.createdAt.toLocaleString("es-ES")}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
