import { redirect } from "next/navigation";
import { requireRole } from "@/server/auth/session";
import { getImportErrorReportUrl } from "@/server/services/imports";

export default async function ImportErrorsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await requireRole("MANAGER");
  const result = await getImportErrorReportUrl(context.organizationId, id);

  if (result.url) {
    redirect(result.url);
  }

  return (
    <div className="max-w-md">
      <h1 className="text-lg font-semibold text-foreground">Sin informe de errores</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {"message" in result ? result.message : "Esta importación no tiene filas rechazadas."}
      </p>
    </div>
  );
}
