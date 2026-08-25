import Link from "next/link";
import { requireAuthContext } from "@/server/auth/session";
import { listDiscrepancies } from "@/server/services/reconciliation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

const STATUS_LABEL: Record<string, string> = {
  MATCH: "Coincide",
  SHORTAGE: "Faltante",
  SURPLUS: "Excedente",
  EXPECTED_MISSING: "Sin stock esperado",
  PHYSICAL_UNVERIFIED: "Sin verificar",
  REVIEW_REQUIRED: "Requiere revisión",
  RESOLVED: "Resuelta",
  DISMISSED: "Descartada",
};

const SEVERITY_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  LOW: "outline",
  MEDIUM: "secondary",
  HIGH: "destructive",
  CRITICAL: "destructive",
};

export default async function ReconciliationPage() {
  const context = await requireAuthContext();
  const discrepancies = await listDiscrepancies({ organizationId: context.organizationId });

  const openOnes = discrepancies.filter((d) => !["RESOLVED", "DISMISSED"].includes(d.status));
  const closedOnes = discrepancies.filter((d) => ["RESOLVED", "DISMISSED"].includes(d.status));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Conciliación</h1>
        <p className="text-sm text-muted-foreground">
          Comparación entre el stock esperado y lo observado físicamente, por producto y ubicación.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Abiertas ({openOnes.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <DiscrepancyTable rows={openOnes} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Resueltas / descartadas ({closedOnes.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <DiscrepancyTable rows={closedOnes} />
        </CardContent>
      </Card>
    </div>
  );
}

function DiscrepancyTable({
  rows,
}: {
  rows: Awaited<ReturnType<typeof listDiscrepancies>>;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No hay registros.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Producto</TableHead>
          <TableHead>Ubicación</TableHead>
          <TableHead>Esperado</TableHead>
          <TableHead>Observado</TableHead>
          <TableHead>Diferencia</TableHead>
          <TableHead>Severidad</TableHead>
          <TableHead>Estado</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <Link href={`/reconciliation/${row.id}`} className="font-medium text-foreground hover:underline">
                {row.product.name}
              </Link>
              <div className="text-xs text-muted-foreground">{row.product.sku}</div>
            </TableCell>
            <TableCell>{row.location.code}</TableCell>
            <TableCell>{row.expectedQuantity ?? "—"}</TableCell>
            <TableCell>{row.observedQuantity ?? "—"}</TableCell>
            <TableCell>{row.difference ?? "—"}</TableCell>
            <TableCell>
              {row.severity ? (
                <Badge variant={SEVERITY_VARIANT[row.severity] ?? "outline"}>{row.severity}</Badge>
              ) : (
                "—"
              )}
            </TableCell>
            <TableCell>{STATUS_LABEL[row.status] ?? row.status}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
