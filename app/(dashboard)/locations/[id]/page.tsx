import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuthContext } from "@/server/auth/session";
import { getLocationWithAncestors } from "@/server/services/locations";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/errors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LocationQrDialog } from "../_components/location-qr-dialog";

const TYPE_LABELS: Record<string, string> = {
  WAREHOUSE: "Almacén",
  ZONE: "Zona",
  AISLE: "Pasillo",
  RACK: "Estantería",
  LEVEL: "Nivel",
  BIN: "Contenedor",
};

export default async function LocationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await requireAuthContext();
  const { id } = await params;

  let ancestry;
  try {
    ancestry = await getLocationWithAncestors(context.organizationId, id);
  } catch (error) {
    if (error instanceof ApiError && error.code === "LOCATION_NOT_FOUND") {
      notFound();
    }
    throw error;
  }

  const location = ancestry[ancestry.length - 1];

  const productLocations = await prisma.productLocation.findMany({
    where: { locationId: location.id },
    include: { product: true },
  });

  return (
    <div className="space-y-6">
      <div>
        <nav className="mb-1 flex items-center gap-1 text-sm text-muted-foreground">
          {ancestry.map((ancestor, index) => (
            <span key={ancestor.id} className="flex items-center gap-1">
              {index > 0 && <span>/</span>}
              {ancestor.id === location.id ? (
                <span className="text-foreground">{ancestor.code}</span>
              ) : (
                <Link href={`/locations/${ancestor.id}`} className="hover:underline">
                  {ancestor.code}
                </Link>
              )}
            </span>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold text-foreground">{location.name}</h1>
          <Badge variant={location.active ? "default" : "secondary"}>
            {location.active ? "Activa" : "Inactiva"}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {location.code} · {TYPE_LABELS[location.type] ?? location.type}
        </p>
      </div>

      <div>
        <LocationQrDialog locationId={location.id} code={location.code} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Productos asignados</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Producto</TableHead>
                <TableHead>Principal</TableHead>
                <TableHead>Mín.</TableHead>
                <TableHead>Máx.</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {productLocations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    Sin productos asignados a esta ubicación.
                  </TableCell>
                </TableRow>
              )}
              {productLocations.map((pl) => (
                <TableRow key={pl.productId}>
                  <TableCell>
                    <Link href={`/products/${pl.productId}`} className="hover:underline">
                      {pl.product.sku} · {pl.product.name}
                    </Link>
                  </TableCell>
                  <TableCell>{pl.isPrimary ? "Sí" : "—"}</TableCell>
                  <TableCell>{pl.minimumQuantity ?? "—"}</TableCell>
                  <TableCell>{pl.maximumQuantity ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
