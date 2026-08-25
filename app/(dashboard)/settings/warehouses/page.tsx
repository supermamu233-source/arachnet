import { requireAuthContext } from "@/server/auth/session";
import { listWarehouses } from "@/server/services/warehouses";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { CreateWarehouseDialog } from "@/components/settings/create-warehouse-dialog";

export default async function SettingsWarehousesPage() {
  const context = await requireAuthContext();
  const warehouses = await listWarehouses(context.organizationId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Almacenes</h1>
          <p className="text-sm text-muted-foreground">Cada almacén contiene su propia jerarquía de ubicaciones.</p>
        </div>
        <CreateWarehouseDialog />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Almacenes ({warehouses.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {warehouses.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aún no hay almacenes.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Código</TableHead>
                  <TableHead>Dirección</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {warehouses.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell>{w.name}</TableCell>
                    <TableCell className="font-mono text-sm">{w.code}</TableCell>
                    <TableCell className="text-muted-foreground">{w.address ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={w.active ? "default" : "secondary"}>{w.active ? "Activo" : "Inactivo"}</Badge>
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
