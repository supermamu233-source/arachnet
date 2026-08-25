import Link from "next/link";
import { requireRole } from "@/server/auth/session";
import { listExportJobs } from "@/server/services/exports";
import { listWarehouses } from "@/server/services/warehouses";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { CreateExportForm } from "@/components/exports/create-export-form";

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pendiente",
  PROCESSING: "Procesando",
  COMPLETED: "Completado",
  FAILED: "Fallido",
};

export default async function ExportsPage() {
  const context = await requireRole("COUNTER");
  const [jobs, warehouses] = await Promise.all([
    listExportJobs(context.organizationId),
    listWarehouses(context.organizationId),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Exportaciones</h1>
        <p className="text-sm text-muted-foreground">
          Genera un libro Excel con conteos, resumen por producto, incidencias abiertas y metadatos del snapshot.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Nueva exportación</CardTitle>
        </CardHeader>
        <CardContent>
          <CreateExportForm warehouses={warehouses} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Historial ({jobs.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aún no hay exportaciones.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Descarga</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {job.snapshotAt.toLocaleString("es-ES")}
                    </TableCell>
                    <TableCell>
                      <Badge variant={job.status === "COMPLETED" ? "default" : job.status === "FAILED" ? "destructive" : "secondary"}>
                        {STATUS_LABEL[job.status] ?? job.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {job.status === "COMPLETED" ? (
                        <Link href={`/exports/${job.id}/download`} className="text-sm text-accent hover:underline">
                          Descargar .xlsx
                        </Link>
                      ) : (
                        "—"
                      )}
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
