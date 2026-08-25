import { notFound } from "next/navigation";
import { requireAuthContext } from "@/server/auth/session";
import { getCountSession, listCounts } from "@/server/services/counts";
import { ApiError } from "@/lib/errors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await requireAuthContext();

  let session;
  try {
    session = await getCountSession(context.organizationId, id);
  } catch (error) {
    if (error instanceof ApiError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const counts = await listCounts({ organizationId: context.organizationId, sessionId: session.id });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{session.name}</h1>
          <p className="text-sm text-muted-foreground">{session.type}</p>
        </div>
        <Badge variant={session.status === "OPEN" ? "default" : "secondary"}>{session.status}</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Conteos ({counts.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {counts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin conteos registrados en esta sesión todavía.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Producto</TableHead>
                  <TableHead>Ubicación</TableHead>
                  <TableHead>Cajas</TableHead>
                  <TableHead>Uds/caja</TableHead>
                  <TableHead>Sueltas</TableHead>
                  <TableHead>Total físico</TableHead>
                  <TableHead>Contado por</TableHead>
                  <TableHead>Fecha</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {counts.map((count) => (
                  <TableRow key={count.id}>
                    <TableCell>
                      {count.product.name}
                      <div className="text-xs text-muted-foreground">{count.product.sku}</div>
                    </TableCell>
                    <TableCell>{count.location.code}</TableCell>
                    <TableCell>{count.boxes}</TableCell>
                    <TableCell>{count.unitsPerBox}</TableCell>
                    <TableCell>{count.looseUnits}</TableCell>
                    <TableCell className="font-medium">{count.physicalQuantity}</TableCell>
                    <TableCell className="text-muted-foreground">{count.createdBy.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {count.capturedAt.toLocaleString("es-ES")}
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
