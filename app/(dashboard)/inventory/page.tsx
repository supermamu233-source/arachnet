import Link from "next/link";
import { requireAuthContext } from "@/server/auth/session";
import { listCountSessions } from "@/server/services/counts";
import { listWarehouses } from "@/server/services/warehouses";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CreateSessionDialog } from "@/components/inventory/create-session-dialog";

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Abierta",
  COMPLETED: "Completada",
  CANCELLED: "Cancelada",
};

export default async function InventoryPage() {
  const context = await requireAuthContext();
  const [sessions, warehouses] = await Promise.all([
    listCountSessions({ organizationId: context.organizationId }),
    listWarehouses(context.organizationId),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Conteos</h1>
          <p className="text-sm text-muted-foreground">Sesiones de conteo físico de inventario.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" render={<Link href="/inventory/count" />}>
            Contar ahora
          </Button>
          <CreateSessionDialog warehouses={warehouses} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sesiones ({sessions.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aún no hay sesiones de conteo.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Iniciada</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell>
                      <Link href={`/inventory/sessions/${session.id}`} className="font-medium text-foreground hover:underline">
                        {session.name}
                      </Link>
                    </TableCell>
                    <TableCell>{session.type}</TableCell>
                    <TableCell>
                      <Badge variant={session.status === "OPEN" ? "default" : "secondary"}>
                        {STATUS_LABEL[session.status] ?? session.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {session.startedAt.toLocaleString("es-ES")}
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
