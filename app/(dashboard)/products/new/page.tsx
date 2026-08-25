import { requireRole } from "@/server/auth/session";
import { prisma } from "@/lib/prisma";
import { IntakeWizard } from "./_components/intake-wizard";

export default async function NewProductIntakePage() {
  const context = await requireRole("COUNTER");

  const locations = await prisma.location.findMany({
    where: { organizationId: context.organizationId, active: true },
    orderBy: [{ warehouseId: "asc" }, { code: "asc" }],
    select: { id: true, code: true, name: true, warehouse: { select: { name: true } } },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Nueva alta de producto</h1>
        <p className="text-sm text-muted-foreground">
          Registra un producto encontrado físicamente en el almacén que todavía no está aprobado en el catálogo.
        </p>
      </div>
      <IntakeWizard locations={locations} />
    </div>
  );
}
