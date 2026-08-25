import { requireRole } from "@/server/auth/session";
import { listAuditLog } from "@/server/services/organization";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default async function AuditPage() {
  const context = await requireRole("ADMIN");
  const entries = await listAuditLog({ organizationId: context.organizationId });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Auditoría</h1>
        <p className="text-sm text-muted-foreground">
          Registro inmutable de acciones — creaciones, aprobaciones, cambios de rol y decisiones de discrepancias.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Últimos {entries.length} eventos</CardTitle>
        </CardHeader>
        <CardContent>
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aún no hay actividad registrada.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Acción</TableHead>
                  <TableHead>Entidad</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {entry.createdAt.toLocaleString("es-ES")}
                    </TableCell>
                    <TableCell>
                      {entry.actorUser?.name ?? (
                        <Badge variant="outline">{entry.actorType}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{entry.action}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {entry.entityType} · {entry.entityId.slice(0, 12)}…
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
