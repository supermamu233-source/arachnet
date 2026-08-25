import { requireAuthContext } from "@/server/auth/session";
import { listWarehouses } from "@/server/services/warehouses";
import { listLocations } from "@/server/services/locations";
import { CountWorkflow } from "@/components/inventory/count-workflow";

export default async function CountPage() {
  const context = await requireAuthContext();
  const [warehouses, locations] = await Promise.all([
    listWarehouses(context.organizationId),
    listLocations({ organizationId: context.organizationId }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Contar</h1>
        <p className="text-sm text-muted-foreground">
          Escanea o introduce el código, confirma el producto y registra las cantidades. Funciona sin conexión — se
          sincroniza cuando vuelvas a tener red.
        </p>
      </div>
      <CountWorkflow warehouses={warehouses} locations={locations} />
    </div>
  );
}
