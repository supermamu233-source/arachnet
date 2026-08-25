import Link from "next/link";
import { requireAuthContext } from "@/server/auth/session";
import { prisma } from "@/lib/prisma";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CreateLocationDialog } from "./_components/create-location-dialog";
import { LocationQrDialog } from "./_components/location-qr-dialog";

const TYPE_LABELS: Record<string, string> = {
  WAREHOUSE: "Almacén",
  ZONE: "Zona",
  AISLE: "Pasillo",
  RACK: "Estantería",
  LEVEL: "Nivel",
  BIN: "Contenedor",
};

/** Depth of a location for indentation, computed from the already-fetched
 * flat list (avoids one query per node). */
function computeDepth(locationId: string, byId: Map<string, { parentId: string | null }>): number {
  let depth = 0;
  let current = byId.get(locationId);
  const seen = new Set<string>();
  while (current?.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    depth += 1;
    current = byId.get(current.parentId);
  }
  return depth;
}

export default async function LocationsPage() {
  const context = await requireAuthContext();

  const [warehouses, locations] = await Promise.all([
    prisma.warehouse.findMany({
      where: { organizationId: context.organizationId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true },
    }),
    prisma.location.findMany({
      where: { organizationId: context.organizationId },
      orderBy: [{ warehouseId: "asc" }, { code: "asc" }],
      select: { id: true, code: true, name: true, type: true, active: true, warehouseId: true, parentId: true },
    }),
  ]);

  const byId = new Map(locations.map((location) => [location.id, location]));
  const warehouseNameById = new Map(warehouses.map((warehouse) => [warehouse.id, `${warehouse.code} · ${warehouse.name}`]));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Ubicaciones</h1>
          <p className="text-sm text-muted-foreground">Jerarquía de ubicaciones físicas del almacén.</p>
        </div>
        <CreateLocationDialog warehouses={warehouses} locations={locations} />
      </div>

      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Código</TableHead>
                <TableHead>Nombre</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Almacén</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {locations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No hay ubicaciones registradas todavía.
                  </TableCell>
                </TableRow>
              )}
              {locations.map((location) => {
                const depth = computeDepth(location.id, byId);
                return (
                  <TableRow key={location.id}>
                    <TableCell style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}>
                      <Link href={`/locations/${location.id}`} className="font-medium text-foreground hover:underline">
                        {location.code}
                      </Link>
                    </TableCell>
                    <TableCell>{location.name}</TableCell>
                    <TableCell className="text-muted-foreground">{TYPE_LABELS[location.type] ?? location.type}</TableCell>
                    <TableCell className="text-muted-foreground">{warehouseNameById.get(location.warehouseId) ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={location.active ? "default" : "secondary"}>
                        {location.active ? "Activa" : "Inactiva"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <LocationQrDialog locationId={location.id} code={location.code} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
