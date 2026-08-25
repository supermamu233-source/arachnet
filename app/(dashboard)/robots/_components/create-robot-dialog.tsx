"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const createRobotSchema = z.object({
  warehouseId: z.string().min(1, "Selecciona un almacén."),
  code: z.string().min(1, "El código es obligatorio."),
  name: z.string().min(1, "El nombre es obligatorio."),
});

type CreateRobotForm = z.infer<typeof createRobotSchema>;

interface WarehouseOption {
  id: string;
  name: string;
  code: string;
}

export function CreateRobotDialog({ warehouses }: { warehouses: WarehouseOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateRobotForm>({
    resolver: zodResolver(createRobotSchema),
    defaultValues: { warehouseId: "", code: "", name: "" },
  });

  async function onSubmit(values: CreateRobotForm) {
    setServerError(null);
    const response = await fetch("/api/robots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    const body = await response.json();
    if (!response.ok) {
      setServerError(body.error?.message ?? "No se pudo crear el robot.");
      return;
    }
    reset();
    setOneTimeSecret(body.data.secret as string);
    router.refresh();
  }

  function handleOpenChange(next: boolean) {
    // Closing while the one-time secret is showing means the operator
    // confirmed they copied it — it can never be displayed again after this.
    setOpen(next);
    if (!next) {
      reset();
      setServerError(null);
      setOneTimeSecret(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button>Nuevo robot</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nuevo robot</DialogTitle>
          <DialogDescription>Registra un dispositivo autenticado para capturar observaciones.</DialogDescription>
        </DialogHeader>

        {oneTimeSecret ? (
          <div className="space-y-4">
            <Alert>
              <AlertTitle>Secreto del dispositivo</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>
                  Copia este secreto ahora — no se volverá a mostrar. Configúralo en el robot junto con su código de
                  dispositivo.
                </p>
                <code className="block break-all rounded-md bg-muted px-2 py-1.5 text-xs text-foreground">
                  {oneTimeSecret}
                </code>
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button onClick={() => handleOpenChange(false)}>Ya lo copié</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {serverError && (
              <Alert variant="destructive">
                <AlertDescription>{serverError}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label>Almacén</Label>
              <Controller
                control={control}
                name="warehouseId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Selecciona un almacén" />
                    </SelectTrigger>
                    <SelectContent>
                      {warehouses.map((warehouse) => (
                        <SelectItem key={warehouse.id} value={warehouse.id}>
                          {warehouse.code} · {warehouse.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.warehouseId && <p className="text-sm text-destructive">{errors.warehouseId.message}</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="code">Código</Label>
              <Input id="code" placeholder="scout-001" {...register("code")} />
              {errors.code && <p className="text-sm text-destructive">{errors.code.message}</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">Nombre</Label>
              <Input id="name" placeholder="Robot explorador 1" {...register("name")} />
              {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
            </div>

            <DialogFooter>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Creando…" : "Crear"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
