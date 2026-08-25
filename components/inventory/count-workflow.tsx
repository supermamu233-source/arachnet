"use client";

import { useEffect, useState } from "react";
import {
  createDraftCount,
  getQueueStatusCounts,
  QueueFullError,
  syncQueuedCounts,
  type QueuedCountState,
} from "@/lib/offline-queue";
import { BarcodeScanner } from "@/components/inventory/barcode-scanner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface LocationOption {
  id: string;
  code: string;
  name: string;
  warehouseId: string;
}
interface WarehouseOption {
  id: string;
  name: string;
  code: string;
}
interface MatchedProduct {
  id: string;
  sku: string;
  name: string;
  defaultUnitsPerBox: number;
}

const STATE_LABEL: Record<QueuedCountState, string> = {
  DRAFT: "Pendiente de enviar",
  PENDING: "En cola",
  UPLOADING: "Enviando",
  COMMITTED: "Confirmado",
  FAILED_RETRYABLE: "Reintentando",
  FAILED_PERMANENT: "Requiere atención",
};

export function CountWorkflow({
  warehouses,
  locations,
}: {
  warehouses: WarehouseOption[];
  locations: LocationOption[];
}) {
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? "");
  const [locationId, setLocationId] = useState("");
  const [product, setProduct] = useState<MatchedProduct | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [boxes, setBoxes] = useState("0");
  const [looseUnits, setLooseUnits] = useState("0");
  const [observation, setObservation] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [queueStatus, setQueueStatus] = useState<Record<QueuedCountState, number> | null>(null);
  const [syncing, setSyncing] = useState(false);

  const availableLocations = locations.filter((l) => l.warehouseId === warehouseId);

  async function refreshQueueStatus() {
    setQueueStatus(await getQueueStatusCounts());
  }

  useEffect(() => {
    let cancelled = false;
    getQueueStatusCounts().then((status) => {
      if (!cancelled) setQueueStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function lookupProduct(code: string) {
    setLookupError(null);
    setProduct(null);
    const res = await fetch(`/api/products/lookup?code=${encodeURIComponent(code)}`);
    const body = await res.json();
    if (body.error) {
      setLookupError(`Sin coincidencia exacta para "${code}".`);
      return;
    }
    setProduct(body.data);
  }

  const computedTotal = product ? Number(boxes || 0) * product.defaultUnitsPerBox + Number(looseUnits || 0) : null;

  async function saveDraft() {
    if (!product || !locationId || !warehouseId) return;
    setSaveMessage(null);
    try {
      await createDraftCount({
        warehouseId,
        locationId,
        productId: product.id,
        boxes: Number(boxes || 0),
        looseUnits: Number(looseUnits || 0),
        observation: observation || undefined,
        capturedAt: new Date().toISOString(),
        photos: photo ? [{ blob: photo, contentType: (photo.type || "image/jpeg") as "image/jpeg" }] : [],
      });
      setSaveMessage("Conteo guardado localmente. Se sincronizará cuando haya conexión.");
      setProduct(null);
      setBoxes("0");
      setLooseUnits("0");
      setObservation("");
      setPhoto(null);
      await refreshQueueStatus();
    } catch (e) {
      if (e instanceof QueueFullError) {
        setSaveMessage("La cola local está llena (250 registros activos). Sincroniza antes de continuar.");
      } else {
        setSaveMessage(e instanceof Error ? e.message : "Error al guardar.");
      }
    }
  }

  async function syncNow() {
    setSyncing(true);
    try {
      await syncQueuedCounts();
      await refreshQueueStatus();
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle>1. Ubicación</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Select value={warehouseId} onValueChange={(v) => v && setWarehouseId(v)}>
              <SelectTrigger className="w-full max-w-sm">
                <SelectValue placeholder="Almacén" />
              </SelectTrigger>
              <SelectContent>
                {warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name} ({w.code})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={locationId} onValueChange={(v) => v && setLocationId(v)}>
              <SelectTrigger className="w-full max-w-sm">
                <SelectValue placeholder="Ubicación" />
              </SelectTrigger>
              <SelectContent>
                {availableLocations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.code} · {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. Escanear producto (EAN o SKU)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <BarcodeScanner onDecode={lookupProduct} />
            {lookupError && (
              <Alert variant="destructive">
                <AlertDescription>{lookupError}</AlertDescription>
              </Alert>
            )}
            {product && (
              <Alert>
                <AlertDescription>
                  {product.name} ({product.sku}) — {product.defaultUnitsPerBox} unidades/caja
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {product && (
          <Card>
            <CardHeader>
              <CardTitle>3. Cantidades y fotografía</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 max-w-sm">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="boxes">Cajas</Label>
                  <Input id="boxes" type="number" min={0} value={boxes} onChange={(e) => setBoxes(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="loose">Sueltas</Label>
                  <Input id="loose" type="number" min={0} value={looseUnits} onChange={(e) => setLooseUnits(e.target.value)} />
                </div>
              </div>
              {computedTotal != null && (
                <p className="text-sm text-muted-foreground">Total físico estimado: {computedTotal}</p>
              )}
              <div className="space-y-2">
                <Label htmlFor="observation">Observaciones</Label>
                <Textarea id="observation" value={observation} onChange={(e) => setObservation(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="photo">Fotografía (opcional)</Label>
                <Input
                  id="photo"
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
                />
              </div>
              {saveMessage && (
                <Alert>
                  <AlertDescription>{saveMessage}</AlertDescription>
                </Alert>
              )}
              <Button onClick={saveDraft} disabled={!locationId}>
                Guardar (offline)
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Cola de sincronización</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {queueStatus &&
            (Object.entries(queueStatus) as [QueuedCountState, number][])
              .filter(([, count]) => count > 0)
              .map(([state, count]) => (
                <div key={state} className="flex items-center justify-between text-sm">
                  <span>{STATE_LABEL[state]}</span>
                  <Badge variant={state === "COMMITTED" ? "default" : state === "FAILED_PERMANENT" ? "destructive" : "secondary"}>
                    {count}
                  </Badge>
                </div>
              ))}
          {queueStatus && Object.values(queueStatus).every((c) => c === 0) && (
            <p className="text-sm text-muted-foreground">Sin conteos en cola.</p>
          )}
          <Button variant="outline" size="sm" onClick={syncNow} disabled={syncing} className="w-full">
            {syncing ? "Sincronizando…" : "Sincronizar ahora"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
