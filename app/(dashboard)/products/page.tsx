import Link from "next/link";
import { requireAuthContext } from "@/server/auth/session";
import { prisma } from "@/lib/prisma";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CreateProductDialog } from "./_components/create-product-dialog";

export default async function ProductsPage() {
  const context = await requireAuthContext();

  const [products, pendingIntakes] = await Promise.all([
    prisma.product.findMany({
      where: { organizationId: context.organizationId, active: true },
      orderBy: { name: "asc" },
      include: { barcodes: true },
      take: 200,
    }),
    prisma.productIntake.findMany({
      where: { organizationId: context.organizationId, status: "READY_FOR_REVIEW" },
      orderBy: { createdAt: "desc" },
      include: { location: { select: { code: true, name: true } } },
      take: 100,
    }),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Productos</h1>
          <p className="text-sm text-muted-foreground">Catálogo de productos de la organización.</p>
        </div>
        <CreateProductDialog />
      </div>

      <Tabs defaultValue="existing">
        <TabsList>
          <TabsTrigger value="existing">Existentes</TabsTrigger>
          <TabsTrigger value="pending">Por añadir ({pendingIntakes.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="existing" className="mt-4">
          <Card>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Nombre</TableHead>
                    <TableHead>Categoría</TableHead>
                    <TableHead>Marca</TableHead>
                    <TableHead>Uds./caja</TableHead>
                    <TableHead>Códigos</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {products.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground">
                        No hay productos activos todavía.
                      </TableCell>
                    </TableRow>
                  )}
                  {products.map((product) => (
                    <TableRow key={product.id}>
                      <TableCell>
                        <Link href={`/products/${product.id}`} className="font-medium text-foreground hover:underline">
                          {product.sku}
                        </Link>
                      </TableCell>
                      <TableCell>{product.name}</TableCell>
                      <TableCell className="text-muted-foreground">{product.category ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{product.brand ?? "—"}</TableCell>
                      <TableCell>{product.defaultUnitsPerBox}</TableCell>
                      <TableCell>{product.barcodes.length}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pending" className="mt-4">
          <Card>
            <CardContent>
              <p className="mb-3 text-sm text-muted-foreground">
                Productos detectados físicamente en el almacén, pendientes de revisión y aprobación. El flujo
                completo de alta se implementará en una fase posterior.
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>EAN capturado</TableHead>
                    <TableHead>SKU capturado</TableHead>
                    <TableHead>Ubicación</TableHead>
                    <TableHead>Cantidad física</TableHead>
                    <TableHead>Estado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendingIntakes.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        No hay altas pendientes de revisión.
                      </TableCell>
                    </TableRow>
                  )}
                  {pendingIntakes.map((intake) => (
                    <TableRow key={intake.id}>
                      <TableCell>{intake.normalizedEan ?? intake.rawEan ?? "—"}</TableCell>
                      <TableCell>{intake.normalizedSku ?? intake.rawSku ?? "—"}</TableCell>
                      <TableCell>{intake.location.code} · {intake.location.name}</TableCell>
                      <TableCell>{intake.physicalQuantity}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">Listo para revisión</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
