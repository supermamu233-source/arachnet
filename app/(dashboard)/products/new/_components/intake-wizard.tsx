"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface LocationOption {
  id: string;
  code: string;
  name: string;
  warehouse: { name: string };
}

const STEP_LABELS = [
  "Ubicación",
  "EAN",
  "Referencia",
  "Comprobación",
  "Fotografías",
  "Cantidades",
  "Revisar",
  "Guardar",
] as const;

type EvidenceKind = "PRODUCT_IMAGE" | "LABEL_IMAGE";

interface EvidenceState {
  assetId: string | null;
  previewUrl: string | null;
  uploading: boolean;
  error: string | null;
}

const EMPTY_EVIDENCE: EvidenceState = { assetId: null, previewUrl: null, uploading: false, error: null };

interface CheckResult {
  loading: boolean;
  error: string | null;
  eanProductId: string | null;
  eanProductName: string | null;
  skuProductId: string | null;
  skuProductName: string | null;
}

const EMPTY_CHECK: CheckResult = {
  loading: false,
  error: null,
  eanProductId: null,
  eanProductName: null,
  skuProductId: null,
  skuProductName: null,
};

/** Deterministic JSON stringify (sorted keys) for hashing the submitted
 * payload client-side. Does not need to share code with lib/hashing.ts —
 * the server independently recomputes/validates nothing about this hash's
 * derivation, it only compares it byte-for-byte against a replay's hash. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function uploadEvidence(file: File, purpose: EvidenceKind): Promise<string> {
  const presignRes = await fetch("/api/evidence/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ purpose, contentType: file.type, maxBytes: file.size }),
  });
  const presignBody = await presignRes.json();
  if (!presignRes.ok) {
    throw new Error(presignBody.error?.message ?? "No se pudo iniciar la subida de la imagen.");
  }
  const { uploadUrl, assetId } = presignBody.data as { uploadUrl: string; assetId: string };

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!putRes.ok) {
    throw new Error("No se pudo subir la imagen al almacenamiento.");
  }

  const finalizeRes = await fetch("/api/evidence/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assetId }),
  });
  const finalizeBody = await finalizeRes.json();
  if (!finalizeRes.ok) {
    throw new Error(finalizeBody.error?.message ?? "No se pudo verificar la imagen subida.");
  }
  return assetId;
}

export function IntakeWizard({ locations }: { locations: LocationOption[] }) {
  const router = useRouter();
  const [step, setStep] = useState(0);

  const [locationId, setLocationId] = useState<string>("");
  const [rawEan, setRawEan] = useState("");
  const [rawSku, setRawSku] = useState("");
  const [boxes, setBoxes] = useState(0);
  const [unitsPerBox, setUnitsPerBox] = useState(1);
  const [looseUnits, setLooseUnits] = useState(0);

  const [productImage, setProductImage] = useState<EvidenceState>(EMPTY_EVIDENCE);
  const [labelImage, setLabelImage] = useState<EvidenceState>(EMPTY_EVIDENCE);

  const [check, setCheck] = useState<CheckResult>(EMPTY_CHECK);
  const [checked, setChecked] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<{ id: string; status: string } | null>(null);

  const physicalQuantity = useMemo(() => boxes * unitsPerBox + looseUnits, [boxes, unitsPerBox, looseUnits]);
  const selectedLocation = locations.find((l) => l.id === locationId) ?? null;

  function canAdvanceFrom(current: number): boolean {
    if (current === 0) return locationId.length > 0;
    if (current === 5) return unitsPerBox >= 1 && boxes >= 0 && looseUnits >= 0;
    return true;
  }

  async function runCheck() {
    setCheck({ ...EMPTY_CHECK, loading: true });
    try {
      const queries: Array<Promise<{ kind: "ean" | "sku"; productId: string | null; name: string | null }>> = [];
      if (rawEan.trim()) {
        queries.push(
          fetch(`/api/products/search?mode=exact&q=${encodeURIComponent(rawEan.trim())}`)
            .then((r) => r.json())
            .then((body) => {
              const match = body.data?.exactMatches?.[0];
              return { kind: "ean" as const, productId: match?.product?.id ?? null, name: match?.product?.name ?? null };
            }),
        );
      }
      if (rawSku.trim()) {
        queries.push(
          fetch(`/api/products/search?mode=exact&q=${encodeURIComponent(rawSku.trim())}`)
            .then((r) => r.json())
            .then((body) => {
              const match = body.data?.exactMatches?.[0];
              return { kind: "sku" as const, productId: match?.product?.id ?? null, name: match?.product?.name ?? null };
            }),
        );
      }
      const results = await Promise.all(queries);
      const eanResult = results.find((r) => r.kind === "ean");
      const skuResult = results.find((r) => r.kind === "sku");
      setCheck({
        loading: false,
        error: null,
        eanProductId: eanResult?.productId ?? null,
        eanProductName: eanResult?.name ?? null,
        skuProductId: skuResult?.productId ?? null,
        skuProductName: skuResult?.name ?? null,
      });
    } catch {
      setCheck({ ...EMPTY_CHECK, loading: false, error: "No se pudo comprobar coincidencias con el catálogo." });
    } finally {
      setChecked(true);
    }
  }

  async function handleFileSelected(file: File, kind: EvidenceKind) {
    const setState = kind === "PRODUCT_IMAGE" ? setProductImage : setLabelImage;
    setState({ assetId: null, previewUrl: URL.createObjectURL(file), uploading: true, error: null });
    try {
      const assetId = await uploadEvidence(file, kind);
      setState((prev) => ({ ...prev, assetId, uploading: false }));
    } catch (error) {
      setState((prev) => ({ ...prev, uploading: false, error: error instanceof Error ? error.message : "Error al subir." }));
    }
  }

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const payload = {
        locationId,
        rawEan: rawEan.trim() || undefined,
        eanCaptureMethod: rawEan.trim() ? ("MANUAL" as const) : undefined,
        rawSku: rawSku.trim() || undefined,
        skuCaptureMethod: rawSku.trim() ? ("MANUAL" as const) : undefined,
        productImageId: productImage.assetId ?? undefined,
        labelImageId: labelImage.assetId ?? undefined,
        boxes,
        unitsPerBox,
        looseUnits,
      };
      const idempotencyKey = crypto.randomUUID();
      const requestHash = await sha256Hex(stableStringify(payload));

      const res = await fetch("/api/product-intakes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, idempotencyKey, requestHash }),
      });
      const body = await res.json();
      if (!res.ok) {
        setSubmitError(body.error?.message ?? "No se pudo registrar el alta.");
        return;
      }
      setSubmitResult({ id: body.data.intake.id, status: body.data.intake.status });
      router.refresh();
    } catch {
      setSubmitError("No se pudo conectar con el servidor.");
    } finally {
      setSubmitting(false);
    }
  }

  function statusBadge(status: string) {
    if (status === "MATCHED_EXISTING") return <Badge variant="secondary">Coincidencia exacta encontrada</Badge>;
    if (status === "CONFLICT") return <Badge variant="destructive">Conflicto: revisar manualmente</Badge>;
    return <Badge variant="outline">Listo para revisión</Badge>;
  }

  if (submitResult) {
    return (
      <Card>
        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription>
              Alta registrada correctamente. Estado: {statusBadge(submitResult.status)}
            </AlertDescription>
          </Alert>
          <div className="flex gap-2">
            <Button onClick={() => router.push(`/products/intakes/${submitResult.id}`)}>Ver detalle</Button>
            <Button variant="outline" onClick={() => router.push("/products")}>
              Volver a productos
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        {STEP_LABELS.map((label, index) => (
          <li key={label}>
            <span
              className={
                index === step
                  ? "rounded-full bg-primary px-2.5 py-1 font-medium text-primary-foreground"
                  : index < step
                    ? "rounded-full bg-secondary px-2.5 py-1 text-secondary-foreground"
                    : "rounded-full bg-muted px-2.5 py-1"
              }
            >
              {index + 1}. {label}
            </span>
          </li>
        ))}
      </ol>

      <Card>
        <CardContent className="space-y-4">
          {step === 0 && (
            <div className="space-y-2">
              <Label>Ubicación</Label>
              <Select value={locationId} onValueChange={(v) => v && setLocationId(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Selecciona una ubicación" />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((location) => (
                    <SelectItem key={location.id} value={location.id}>
                      {location.code} · {location.name} ({location.warehouse.name})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {locations.length === 0 && (
                <p className="text-sm text-muted-foreground">No hay ubicaciones activas disponibles.</p>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-2">
              <Label htmlFor="rawEan">EAN / código de barras</Label>
              <Input
                id="rawEan"
                placeholder="Introduce el código EAN (opcional si no tiene)"
                value={rawEan}
                onChange={(e) => setRawEan(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Captura manual para esta fase — el escaneo con cámara se integrará en el flujo de conteos.
              </p>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-2">
              <Label htmlFor="rawSku">Referencia / SKU</Label>
              <Input
                id="rawSku"
                placeholder="Introduce la referencia (opcional si no tiene)"
                value={rawSku}
                onChange={(e) => setRawSku(e.target.value)}
              />
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Comprueba si el EAN o la referencia capturados coinciden exactamente con un producto ya existente en
                el catálogo. Solo una coincidencia exacta se considera un enlace válido — nunca se aprueba
                automáticamente.
              </p>
              <Button type="button" variant="outline" onClick={runCheck} disabled={check.loading}>
                {check.loading ? "Comprobando…" : "Comprobar coincidencias"}
              </Button>
              {check.error && (
                <Alert variant="destructive">
                  <AlertDescription>{check.error}</AlertDescription>
                </Alert>
              )}
              {checked && !check.loading && !check.error && (
                <div className="space-y-2 text-sm">
                  <p>
                    EAN: {rawEan.trim() ? (check.eanProductId ? `coincide con "${check.eanProductName}"` : "sin coincidencia") : "no capturado"}
                  </p>
                  <p>
                    Referencia: {rawSku.trim() ? (check.skuProductId ? `coincide con "${check.skuProductName}"` : "sin coincidencia") : "no capturada"}
                  </p>
                  {check.eanProductId && check.skuProductId && check.eanProductId !== check.skuProductId && (
                    <Alert variant="destructive">
                      <AlertDescription>
                        Conflicto: el EAN y la referencia coinciden con productos distintos. Podrás continuar, pero
                        un responsable deberá resolverlo manualmente antes de aprobar el alta.
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              )}
            </div>
          )}

          {step === 4 && (
            <div className="grid gap-4 sm:grid-cols-2">
              <EvidencePicker
                label="Foto del producto"
                state={productImage}
                onFile={(file) => handleFileSelected(file, "PRODUCT_IMAGE")}
              />
              <EvidencePicker
                label="Foto de la etiqueta"
                state={labelImage}
                onFile={(file) => handleFileSelected(file, "LABEL_IMAGE")}
              />
            </div>
          )}

          {step === 5 && (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="boxes">Cajas</Label>
                <Input
                  id="boxes"
                  type="number"
                  min={0}
                  value={boxes}
                  onChange={(e) => setBoxes(Math.max(0, Number(e.target.value)))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="unitsPerBox">Unidades por caja</Label>
                <Input
                  id="unitsPerBox"
                  type="number"
                  min={1}
                  value={unitsPerBox}
                  onChange={(e) => setUnitsPerBox(Math.max(1, Number(e.target.value)))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="looseUnits">Unidades sueltas</Label>
                <Input
                  id="looseUnits"
                  type="number"
                  min={0}
                  value={looseUnits}
                  onChange={(e) => setLooseUnits(Math.max(0, Number(e.target.value)))}
                />
              </div>
              <div className="col-span-full">
                <Alert>
                  <AlertDescription>
                    Cantidad física total calculada: <strong>{physicalQuantity}</strong> unidades. El servidor
                    recalcula y valida este valor — no es editable directamente.
                  </AlertDescription>
                </Alert>
              </div>
            </div>
          )}

          {step === 6 && (
            <div className="space-y-2 text-sm">
              <h2 className="font-medium text-foreground">Resumen</h2>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">Ubicación</dt>
                <dd>{selectedLocation ? `${selectedLocation.code} · ${selectedLocation.name}` : "—"}</dd>
                <dt className="text-muted-foreground">EAN</dt>
                <dd>{rawEan.trim() || "—"}</dd>
                <dt className="text-muted-foreground">Referencia</dt>
                <dd>{rawSku.trim() || "—"}</dd>
                <dt className="text-muted-foreground">Foto de producto</dt>
                <dd>{productImage.assetId ? "Subida y verificada" : "No adjuntada"}</dd>
                <dt className="text-muted-foreground">Foto de etiqueta</dt>
                <dd>{labelImage.assetId ? "Subida y verificada" : "No adjuntada"}</dd>
                <dt className="text-muted-foreground">Cajas</dt>
                <dd>{boxes}</dd>
                <dt className="text-muted-foreground">Unidades por caja</dt>
                <dd>{unitsPerBox}</dd>
                <dt className="text-muted-foreground">Unidades sueltas</dt>
                <dd>{looseUnits}</dd>
                <dt className="text-muted-foreground">Cantidad física total</dt>
                <dd className="font-medium">{physicalQuantity}</dd>
              </dl>
            </div>
          )}

          {step === 7 && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Al guardar, el servidor volverá a calcular la cantidad física, comprobará coincidencias exactas en
                el catálogo y dejará el alta lista para revisión por un responsable.
              </p>
              {submitError && (
                <Alert variant="destructive">
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              )}
              <Button onClick={handleSubmit} disabled={submitting}>
                {submitting ? "Guardando…" : "Guardar alta"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {step < 7 && (
        <div className="flex justify-between">
          <Button variant="outline" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
            Anterior
          </Button>
          <Button onClick={() => setStep((s) => Math.min(STEP_LABELS.length - 1, s + 1))} disabled={!canAdvanceFrom(step)}>
            Siguiente
          </Button>
        </div>
      )}
      {step === 7 && (
        <div className="flex justify-start">
          <Button variant="outline" onClick={() => setStep((s) => Math.max(0, s - 1))}>
            Anterior
          </Button>
        </div>
      )}
    </div>
  );
}

function EvidencePicker({
  label,
  state,
  onFile,
}: {
  label: string;
  state: EvidenceState;
  onFile: (file: File) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {state.previewUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- local object URL preview, not a remote/optimizable image
        <img src={state.previewUrl} alt={label} className="h-32 w-full rounded-md object-cover" />
      )}
      <Input
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
        }}
      />
      {state.uploading && <p className="text-xs text-muted-foreground">Subiendo…</p>}
      {state.assetId && !state.uploading && <Badge variant="outline">Verificada</Badge>}
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
