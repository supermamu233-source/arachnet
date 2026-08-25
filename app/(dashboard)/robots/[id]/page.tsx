import { notFound } from "next/navigation";
import { requireAuthContext } from "@/server/auth/session";
import { getRobotStatus } from "@/server/services/robots";
import { ApiError } from "@/lib/errors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { RobotActions } from "@/app/(dashboard)/robots/_components/robot-actions";

const CONFIDENCE_LABEL: Record<string, string> = {
  HIGH: "Alta",
  MEDIUM: "Media",
  LOW: "Baja",
  REVIEW_REQUIRED: "Requiere revisión",
};

const STATUS_LABEL: Record<string, string> = {
  ACCEPTED: "Aceptada",
  REVIEW_REQUIRED: "Requiere revisión",
  REJECTED: "Rechazada",
};

export default async function RobotDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await requireAuthContext();
  const { id } = await params;

  let robot: Awaited<ReturnType<typeof getRobotStatus>>["robot"];
  let recentObservations: Awaited<ReturnType<typeof getRobotStatus>>["recentObservations"];
  try {
    ({ robot, recentObservations } = await getRobotStatus({ organizationId: context.organizationId, robotId: id }));
  } catch (error) {
    if (error instanceof ApiError && (error.code === "NOT_FOUND" || error.code === "ORGANIZATION_MISMATCH")) {
      notFound();
    }
    throw error;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{robot.name}</h1>
          <p className="text-sm text-muted-foreground">Código: {robot.code}</p>
        </div>
        <RobotActions robotId={robot.id} status={robot.status} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Estado</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <p className="text-muted-foreground">Estado</p>
            <Badge variant={robot.status === "ACTIVE" ? "default" : "outline"}>
              {robot.status === "ACTIVE" ? "Activo" : "Deshabilitado"}
            </Badge>
          </div>
          <div>
            <p className="text-muted-foreground">Última actividad</p>
            <p>{robot.lastSeenAt ? new Date(robot.lastSeenAt).toLocaleString("es-AU") : "Nunca"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Firmware</p>
            <p>{robot.firmwareVersion ?? "—"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Creado</p>
            <p>{new Date(robot.createdAt).toLocaleDateString("es-AU")}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Observaciones recientes ({recentObservations.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {recentObservations.length === 0 ? (
            <p className="text-sm text-muted-foreground">Este robot todavía no ha enviado observaciones.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Capturado</TableHead>
                  <TableHead>Producto</TableHead>
                  <TableHead>Ubicación</TableHead>
                  <TableHead>Esperado</TableHead>
                  <TableHead>Observado</TableHead>
                  <TableHead>Diferencia</TableHead>
                  <TableHead>Confianza</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentObservations.map((observation) => (
                  <TableRow key={observation.id}>
                    <TableCell>{new Date(observation.capturedAt).toLocaleString("es-AU")}</TableCell>
                    <TableCell>{observation.product?.name ?? "Sin coincidencia"}</TableCell>
                    <TableCell>{observation.location.code}</TableCell>
                    <TableCell>{observation.expectedQuantity ?? "—"}</TableCell>
                    <TableCell>{observation.observedQuantity}</TableCell>
                    <TableCell>{observation.difference ?? "—"}</TableCell>
                    <TableCell>{CONFIDENCE_LABEL[observation.confidenceLevel] ?? observation.confidenceLevel}</TableCell>
                    <TableCell>
                      <Badge variant={observation.status === "ACCEPTED" ? "default" : "secondary"}>
                        {STATUS_LABEL[observation.status] ?? observation.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
