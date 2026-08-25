"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface RobotActionsProps {
  robotId: string;
  status: "ACTIVE" | "DISABLED";
}

export function RobotActions({ robotId, status }: RobotActionsProps) {
  const router = useRouter();
  const [rotateOpen, setRotateOpen] = useState(false);
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function rotateSecret() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/robots/${robotId}/rotate-secret`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error?.message ?? "No se pudo rotar el secreto.");
        return;
      }
      setOneTimeSecret(body.data.secret as string);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      await fetch(`/api/robots/${robotId}/disable`, { method: "POST" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex gap-2">
      <Dialog
        open={rotateOpen}
        onOpenChange={(next) => {
          setRotateOpen(next);
          if (!next) {
            setOneTimeSecret(null);
            setError(null);
          } else {
            void rotateSecret();
          }
        }}
      >
        <DialogTrigger render={<Button variant="outline">Rotar secreto</Button>} />
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rotar secreto del dispositivo</DialogTitle>
            <DialogDescription>
              El secreto anterior dejará de funcionar de inmediato. Actualiza la configuración del robot con el
              nuevo valor.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {busy && !oneTimeSecret && !error && <p className="text-sm text-muted-foreground">Generando…</p>}
          {oneTimeSecret && (
            <Alert>
              <AlertTitle>Nuevo secreto</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>Cópialo ahora — no se volverá a mostrar.</p>
                <code className="block break-all rounded-md bg-muted px-2 py-1.5 text-xs text-foreground">
                  {oneTimeSecret}
                </code>
              </AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button onClick={() => setRotateOpen(false)}>Cerrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {status === "ACTIVE" && (
        <AlertDialog>
          <AlertDialogTrigger render={<Button variant="destructive">Deshabilitar</Button>} />
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>¿Deshabilitar este robot?</AlertDialogTitle>
              <AlertDialogDescription>
                Dejará de poder autenticarse y enviar observaciones hasta que se vuelva a habilitar.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel render={<Button variant="outline" />}>Cancelar</AlertDialogCancel>
              <AlertDialogAction render={<Button variant="destructive" onClick={disable} disabled={busy} />}>
                Deshabilitar
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
