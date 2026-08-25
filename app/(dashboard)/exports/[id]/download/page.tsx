import { redirect } from "next/navigation";
import { requireRole } from "@/server/auth/session";
import { getExportDownloadUrl } from "@/server/services/exports";

export default async function ExportDownloadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await requireRole("COUNTER");
  const { url } = await getExportDownloadUrl(context.organizationId, id);
  redirect(url);
}
