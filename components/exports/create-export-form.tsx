"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { computeRequestHash } from "@/lib/client-hashing";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface WarehouseOption {
  id: string;
  name: string;
  code: string;
}

export function CreateExportForm({ warehouses }: { warehouses: WarehouseOption[] }) {
  const router = useRouter();
  const [warehouseId, setWarehouseId] = useState<string>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const filter = warehouseId === "all" ? {} : { warehouseId };
      const idempotencyKey = crypto.randomUUID();
      const requestHash = await computeRequestHash(filter);

      const res = await fetch("/api/exports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...filter, idempotencyKey, requestHash }),
      });
      const body = await res.json();
      if (body.error) throw new Error(body.error.message);
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
      <div className="flex items-end gap-3">
        <div className="space-y-2">
          <Select value={warehouseId} onValueChange={(v) => v && setWarehouseId(v)}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los almacenes</SelectItem>
              {warehouses.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name} ({w.code})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={generate} disabled={busy}>
          {busy ? "Generando…" : "Generar exportación"}
        </Button>
      </div>
    </div>
  );
}
