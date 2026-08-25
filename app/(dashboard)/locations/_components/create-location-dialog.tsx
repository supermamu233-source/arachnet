"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
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

const LOCATION_TYPES = ["WAREHOUSE", "ZONE", "AISLE", "RACK", "LEVEL", "BIN"] as const;

const LOCATION_TYPE_LABELS: Record<(typeof LOCATION_TYPES)[number], string> = {
  WAREHOUSE: "Almacén",
  ZONE: "Zona",
  AISLE: "Pasillo",
  RACK: "Estantería",
  LEVEL: "Nivel",
  BIN: "Contenedor",
};

const createLocationSchema = z.object({
  warehouseId: z.string().min(1, "Selecciona un almacén."),
  parentId: z.string().optional(),
  code: z.string().min(1, "El código es obligatorio."),
  name: z.string().min(1, "El nombre es obligatorio."),
  type: z.enum(LOCATION_TYPES),
});

type CreateLocationForm = z.infer<typeof createLocationSchema>;

interface WarehouseOption {
  id: string;
  name: string;
  code: string;
}

interface LocationOption {
  id: string;
  code: string;
  name: string;
  warehouseId: string;
}

interface CreateLocationDialogProps {
  warehouses: WarehouseOption[];
  locations: LocationOption[];
}

const NONE_PARENT = "__none__";

export function CreateLocationDialog({ warehouses, locations }: CreateLocationDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateLocationForm>({
    resolver: zodResolver(createLocationSchema),
    defaultValues: { warehouseId: "", parentId: "", code: "", name: "", type: "BIN" },
  });

  const selectedWarehouseId = useWatch({ control, name: "warehouseId" });
  const parentOptions = useMemo(
    () => locations.filter((location) => location.warehouseId === selectedWarehouseId),
    [locations, selectedWarehouseId],
  );

  async function onSubmit(values: CreateLocationForm) {
    setServerError(null);
    const response = await fetch("/api/locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...values,
        parentId: values.parentId && values.parentId.length > 0 ? values.parentId : undefined,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      setServerError(body.error?.message ?? "No se pudo crear la ubicación.");
      return;
    }
    reset();
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          reset();
          setServerError(null);
        }
      }}
    >
      <DialogTrigger render={<Button>Nueva ubicación</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nueva ubicación</DialogTitle>
          <DialogDescription>Añade una ubicación dentro de un almacén.</DialogDescription>
        </DialogHeader>
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
            <Label>Ubicación padre (opcional)</Label>
            <Controller
              control={control}
              name="parentId"
              render={({ field }) => (
                <Select
                  value={field.value && field.value.length > 0 ? field.value : NONE_PARENT}
                  onValueChange={(value) => field.onChange(value === NONE_PARENT ? "" : value)}
                  disabled={!selectedWarehouseId}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Sin ubicación padre" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_PARENT}>Sin ubicación padre</SelectItem>
                    {parentOptions.map((location) => (
                      <SelectItem key={location.id} value={location.id}>
                        {location.code} · {location.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="code">Código</Label>
              <Input id="code" {...register("code")} />
              {errors.code && <p className="text-sm text-destructive">{errors.code.message}</p>}
            </div>
            <div className="space-y-2">
              <Label>Tipo</Label>
              <Controller
                control={control}
                name="type"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LOCATION_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {LOCATION_TYPE_LABELS[type]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="name">Nombre</Label>
            <Input id="name" {...register("name")} />
            {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
