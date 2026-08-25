"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { computeRequestHash } from "@/lib/client-hashing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface WarehouseOption {
  id: string;
  name: string;
  code: string;
}

export function CreateImportForm({ warehouses }: { warehouses: WarehouseOption[] }) {
  const router = useRouter();
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [manualCode, setManualCode] = useState("");
  const [manualLocationCode, setManualLocationCode] = useState("");
  const [manualQuantity, setManualQuantity] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function submitFileImport() {
    if (!file || !warehouseId) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const presignRes = await fetch("/api/imports/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType: file.type || "text/csv" }),
      });
      const presignBody = await presignRes.json();
      if (presignBody.error) throw new Error(presignBody.error.message);

      await fetch(presignBody.data.uploadUrl, { method: "PUT", body: file, headers: { "Content-Type": file.type } });

      const type = file.name.toLowerCase().endsWith(".xlsx") ? "XLSX" : "CSV";
      const idempotencyKey = crypto.randomUUID();
      const payload = { warehouseId, type, fileObjectKey: presignBody.data.objectKey };
      const requestHash = await computeRequestHash(payload);

      const jobRes = await fetch("/api/imports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, idempotencyKey, requestHash }),
      });
      const jobBody = await jobRes.json();
      if (jobBody.error) throw new Error(jobBody.error.message);

      setResult(
        `Importación completada: ${jobBody.data.rowsAccepted ?? 0} aceptadas, ${jobBody.data.rowsRejected ?? 0} rechazadas.`,
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado.");
    } finally {
      setBusy(false);
    }
  }

  async function submitManualEntry() {
    if (!warehouseId || !manualCode || !manualLocationCode || !manualQuantity) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const idempotencyKey = crypto.randomUUID();
      const payload = {
        warehouseId,
        type: "MANUAL" as const,
        manualEntry: {
          code: manualCode,
          locationCode: manualLocationCode,
          quantity: Number(manualQuantity),
        },
      };
      const requestHash = await computeRequestHash(payload);

      const res = await fetch("/api/imports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, idempotencyKey, requestHash }),
      });
      const body = await res.json();
      if (body.error) throw new Error(body.error.message);

      setResult("Entrada manual registrada.");
      setManualCode("");
      setManualLocationCode("");
      setManualQuantity("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {result && (
        <Alert>
          <AlertDescription>{result}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label>Almacén</Label>
        <Select value={warehouseId} onValueChange={(v) => v && setWarehouseId(v)}>
          <SelectTrigger className="w-full max-w-sm">
            <SelectValue placeholder="Selecciona un almacén" />
          </SelectTrigger>
          <SelectContent>
            {warehouses.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name} ({w.code})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Tabs defaultValue="file">
        <TabsList>
          <TabsTrigger value="file">CSV / XLSX</TabsTrigger>
          <TabsTrigger value="manual">Entrada manual</TabsTrigger>
        </TabsList>
        <TabsContent value="file" className="space-y-4 pt-4">
          <div className="space-y-2 max-w-sm">
            <Label htmlFor="file">Archivo</Label>
            <Input
              id="file"
              type="file"
              accept=".csv,.xlsx"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-muted-foreground">
              Columnas esperadas: código de producto (SKU o EAN), código de ubicación, cantidad.
            </p>
          </div>
          <Button onClick={submitFileImport} disabled={busy || !file || !warehouseId}>
            {busy ? "Procesando…" : "Importar archivo"}
          </Button>
        </TabsContent>
        <TabsContent value="manual" className="space-y-4 pt-4">
          <div className="grid max-w-sm grid-cols-1 gap-3">
            <div className="space-y-2">
              <Label htmlFor="manualCode">Código de producto (SKU o EAN)</Label>
              <Input id="manualCode" value={manualCode} onChange={(e) => setManualCode(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manualLocationCode">Código de ubicación</Label>
              <Input
                id="manualLocationCode"
                value={manualLocationCode}
                onChange={(e) => setManualLocationCode(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manualQuantity">Cantidad esperada</Label>
              <Input
                id="manualQuantity"
                type="number"
                min={0}
                value={manualQuantity}
                onChange={(e) => setManualQuantity(e.target.value)}
              />
            </div>
          </div>
          <Button onClick={submitManualEntry} disabled={busy || !warehouseId}>
            {busy ? "Guardando…" : "Guardar entrada manual"}
          </Button>
        </TabsContent>
      </Tabs>
    </div>
  );
}
