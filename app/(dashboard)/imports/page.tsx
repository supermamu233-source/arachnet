import Link from "next/link";
import { requireRole } from "@/server/auth/session";
import { listImportJobs } from "@/server/services/imports";
import { listWarehouses } from "@/server/services/warehouses";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { CreateImportForm } from "@/components/imports/create-import-form";

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pendiente",
  PROCESSING: "Procesando",
  COMPLETED: "Completado",
  FAILED: "Fallido",
};

export default async function ImportsPage() {
  const context = await requireRole("MANAGER");
  const [jobs, warehouses] = await Promise.all([
    listImportJobs(context.organizationId),
    listWarehouses(context.organizationId),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Importaciones</h1>
        <p className="text-sm text-muted-foreground">
          Carga el stock esperado desde CSV, XLSX o entrada manual. Cada fila se resuelve por coincidencia exacta de
          código de producto y ubicación — nunca de forma aproximada.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Nueva importación</CardTitle>
        </CardHeader>
        <CardContent>
          <CreateImportForm warehouses={warehouses} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Historial ({jobs.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aún no hay importaciones.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Filas</TableHead>
                  <TableHead>Errores</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {job.createdAt.toLocaleString("es-ES")}
                    </TableCell>
                    <TableCell>{job.type}</TableCell>
                    <TableCell>
                      <Badge variant={job.status === "COMPLETED" ? "default" : job.status === "FAILED" ? "destructive" : "secondary"}>
                        {STATUS_LABEL[job.status] ?? job.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {job.rowsAccepted ?? 0} / {job.rowsTotal ?? 0}
                    </TableCell>
                    <TableCell>
                      {job.rowsRejected ? (
                        <Link href={`/imports/${job.id}/errors`} className="text-sm text-accent hover:underline">
                          {job.rowsRejected} rechazadas
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
