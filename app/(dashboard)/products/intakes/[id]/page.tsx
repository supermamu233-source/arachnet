import { notFound } from "next/navigation";
import { requireRole } from "@/server/auth/session";
import { getIntake } from "@/server/services/intakes";
import { ApiError } from "@/lib/errors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EvidenceImage } from "@/components/evidence/evidence-image";
import { IntakeDecisionForm } from "@/components/intakes/intake-decision-form";

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Borrador",
  READY_FOR_REVIEW: "Listo para revisión",
  MATCHED_EXISTING: "Coincidencia encontrada",
  APPROVED: "Aprobado",
  REJECTED: "Rechazado",
  CONFLICT: "Conflicto",
};

export default async function IntakeReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await requireRole("MANAGER");

  let intake;
  try {
    intake = await getIntake(context.organizationId, id);
  } catch (error) {
    if (error instanceof ApiError && (error.code === "NOT_FOUND" || error.code === "ORGANIZATION_MISMATCH")) {
      notFound();
    }
    throw error;
  }

  const isPending = intake.status === "READY_FOR_REVIEW" || intake.status === "MATCHED_EXISTING" || intake.status === "CONFLICT";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Revisión de alta física</h1>
          <p className="text-sm text-muted-foreground">{intake.location.code} · {intake.location.name}</p>
        </div>
        <Badge variant="secondary">{STATUS_LABEL[intake.status] ?? intake.status}</Badge>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Identificación capturada</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <span className="text-muted-foreground">EAN:</span> {intake.normalizedEan ?? intake.rawEan ?? "—"}
              {intake.eanCaptureMethod && (
                <span className="ml-2 text-xs text-muted-foreground">({intake.eanCaptureMethod})</span>
              )}
            </p>
            <p>
              <span className="text-muted-foreground">SKU:</span> {intake.normalizedSku ?? intake.rawSku ?? "—"}
              {intake.skuCaptureMethod && (
                <span className="ml-2 text-xs text-muted-foreground">({intake.skuCaptureMethod})</span>
              )}
            </p>
            {intake.candidateProduct && (
              <p>
                <span className="text-muted-foreground">Producto candidato:</span> {intake.candidateProduct.name} (
                {intake.candidateProduct.sku})
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cantidades</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <span className="text-muted-foreground">Cajas:</span> {intake.boxes}
            </p>
            <p>
              <span className="text-muted-foreground">Unidades por caja:</span> {intake.unitsPerBox}
            </p>
            <p>
              <span className="text-muted-foreground">Sueltas:</span> {intake.looseUnits}
            </p>
            <p className="font-medium text-foreground">
              <span className="text-muted-foreground font-normal">Total físico:</span> {intake.physicalQuantity}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Fotografías</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-4">
          {intake.productImageId && <EvidenceImage assetId={intake.productImageId} alt="Foto del producto" />}
          {intake.labelImageId && <EvidenceImage assetId={intake.labelImageId} alt="Foto de la etiqueta" />}
          {!intake.productImageId && !intake.labelImageId && (
            <p className="text-sm text-muted-foreground">Sin fotografías capturadas.</p>
          )}
        </CardContent>
      </Card>

      {isPending ? (
        <Card>
          <CardHeader>
            <CardTitle>Decisión</CardTitle>
          </CardHeader>
          <CardContent>
            <IntakeDecisionForm
              intakeId={intake.id}
              hasCandidate={Boolean(intake.candidateProductId)}
              suggestedSku={intake.normalizedSku ?? undefined}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Resultado</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {intake.status === "APPROVED" && "Esta alta ya fue aprobada."}
            {intake.status === "REJECTED" && (
              <>
                Esta alta fue rechazada{intake.decisionNotes ? `: ${intake.decisionNotes}` : "."}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
