"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface LocationQrDialogProps {
  locationId: string;
  code: string;
}

export function LocationQrDialog({ locationId, code }: LocationQrDialogProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadQr() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/locations/${locationId}/qr`);
      const body = await response.json();
      if (!response.ok) {
        setError(body.error?.message ?? "No se pudo generar el código QR.");
        return;
      }
      setDataUrl(body.data.dataUrl as string);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        if (open && !dataUrl) void loadQr();
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm">Ver QR</Button>} />
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Código QR</DialogTitle>
          <DialogDescription>{code}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-center py-4">
          {loading && <p className="text-sm text-muted-foreground">Generando…</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {dataUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- data: URL, not an optimizable remote image
            <img src={dataUrl} alt={`Código QR de la ubicación ${code}`} className="size-48" />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
