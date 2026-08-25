import Link from "next/link";
import { requireAuthContext } from "@/server/auth/session";
import { listRobots } from "@/server/services/robots";
import { listWarehouses } from "@/server/services/warehouses";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { CreateRobotDialog } from "@/app/(dashboard)/robots/_components/create-robot-dialog";

export default async function RobotsPage() {
  const context = await requireAuthContext();
  const [robots, warehouses] = await Promise.all([
    listRobots(context.organizationId),
    listWarehouses(context.organizationId),
  ]);

  const warehouseNameById = new Map(warehouses.map((w) => [w.id, `${w.code} · ${w.name}`]));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Robots</h1>
          <p className="text-sm text-muted-foreground">
            Dispositivos autenticados que capturan observaciones físicas automáticamente.
          </p>
        </div>
        <CreateRobotDialog warehouses={warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code }))} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Dispositivos ({robots.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {robots.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay robots registrados todavía.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Código</TableHead>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Almacén</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Última actividad</TableHead>
                  <TableHead>Firmware</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {robots.map((robot) => (
                  <TableRow key={robot.id}>
                    <TableCell className="font-medium">
                      <Link href={`/robots/${robot.id}`} className="hover:underline">
                        {robot.code}
                      </Link>
                    </TableCell>
                    <TableCell>{robot.name}</TableCell>
                    <TableCell>{warehouseNameById.get(robot.warehouseId) ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={robot.status === "ACTIVE" ? "default" : "outline"}>
                        {robot.status === "ACTIVE" ? "Activo" : "Deshabilitado"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {robot.lastSeenAt ? new Date(robot.lastSeenAt).toLocaleString("es-AU") : "Nunca"}
                    </TableCell>
                    <TableCell>{robot.firmwareVersion ?? "—"}</TableCell>
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
