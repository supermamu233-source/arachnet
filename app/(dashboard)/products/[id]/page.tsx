import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuthContext } from "@/server/auth/session";
import { prisma } from "@/lib/prisma";
import { isValidEanChecksum } from "@/domain/products/ean";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await requireAuthContext();
  const { id } = await params;

  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      barcodes: true,
      packagingRules: true,
      productLocations: { include: { location: true } },
    },
  });

  if (!product || product.organizationId !== context.organizationId) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold text-foreground">{product.name}</h1>
          {!product.active && <Badge variant="secondary">Archivado</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          SKU {product.sku} {product.brand ? `· ${product.brand}` : ""} {product.category ? `· ${product.category}` : ""}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Códigos de barras</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Valor</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Principal</TableHead>
                <TableHead>Verificación</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {product.barcodes.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    Sin códigos de barras registrados.
                  </TableCell>
                </TableRow>
              )}
              {product.barcodes.map((barcode) => {
                const checksumWarning =
                  (barcode.type === "EAN13" || barcode.type === "EAN8") && !isValidEanChecksum(barcode.value);
                return (
                  <TableRow key={barcode.id}>
                    <TableCell className="font-mono">{barcode.value}</TableCell>
                    <TableCell>{barcode.type}</TableCell>
                    <TableCell>{barcode.isPrimary ? "Sí" : "—"}</TableCell>
                    <TableCell>
                      {checksumWarning ? (
                        <Badge variant="destructive">Dígito de control inválido</Badge>
                      ) : (
                        <Badge variant="outline">OK</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reglas de empaquetado</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Unidades contenidas</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {product.packagingRules.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground">
                    Sin reglas de empaquetado.
                  </TableCell>
                </TableRow>
              )}
              {product.packagingRules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell>{rule.name}</TableCell>
                  <TableCell>{rule.packageType}</TableCell>
                  <TableCell>{rule.unitsContained}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ubicaciones asignadas</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ubicación</TableHead>
                <TableHead>Principal</TableHead>
                <TableHead>Mín.</TableHead>
                <TableHead>Máx.</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {product.productLocations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    Sin ubicaciones asignadas.
                  </TableCell>
                </TableRow>
              )}
              {product.productLocations.map((pl) => (
                <TableRow key={pl.locationId}>
                  <TableCell>
                    <Link href={`/locations/${pl.locationId}`} className="hover:underline">
                      {pl.location.code} · {pl.location.name}
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
