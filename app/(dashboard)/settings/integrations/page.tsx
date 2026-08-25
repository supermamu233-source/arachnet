import { requireRole } from "@/server/auth/session";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default async function SettingsIntegrationsPage() {
  const context = await requireRole("ADMIN");
  const sources = await prisma.inventorySource.findMany({
    where: { organizationId: context.organizationId },
    orderBy: { createdAt: "asc" },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Integraciones</h1>
        <p className="text-sm text-muted-foreground">
          Fuentes de stock esperado (ERP, POS, e-commerce, compras, importaciones manuales). Se crean
          automáticamente al configurar una importación en <code>/imports</code>.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Fuentes configuradas ({sources.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin fuentes configuradas todavía.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.map((source) => (
                  <TableRow key={source.id}>
                    <TableCell>{source.name}</TableCell>
                    <TableCell>{source.type}</TableCell>
                    <TableCell>
                      <Badge variant={source.active ? "default" : "secondary"}>
                        {source.active ? "Activa" : "Inactiva"}
                      </Badge>
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
