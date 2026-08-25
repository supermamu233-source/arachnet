"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const barcodeSchema = z.object({
  value: z.string().min(1, "Obligatorio."),
  type: z.enum(["EAN13", "EAN8", "UPC_A", "CODE128", "OTHER"]),
});

const createProductSchema = z.object({
  sku: z.string().min(1, "El SKU es obligatorio."),
  name: z.string().min(1, "El nombre es obligatorio."),
  category: z.string().optional(),
  brand: z.string().optional(),
  defaultUnitsPerBox: z.number().int().min(1, "Debe ser al menos 1."),
  barcodes: z.array(barcodeSchema),
});

type CreateProductForm = z.infer<typeof createProductSchema>;

export function CreateProductDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateProductForm>({
    resolver: zodResolver(createProductSchema),
    defaultValues: { sku: "", name: "", defaultUnitsPerBox: 1, barcodes: [] },
  });

  const { fields, append, remove } = useFieldArray({ control, name: "barcodes" });

  async function onSubmit(values: CreateProductForm) {
    setServerError(null);
    const response = await fetch("/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    const body = await response.json();
    if (!response.ok) {
      setServerError(body.error?.message ?? "No se pudo crear el producto.");
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
      <DialogTrigger render={<Button>Nuevo producto</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nuevo producto</DialogTitle>
          <DialogDescription>Da de alta un producto en el catálogo.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {serverError && (
            <Alert variant="destructive">
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="sku">SKU</Label>
              <Input id="sku" {...register("sku")} />
              {errors.sku && <p className="text-sm text-destructive">{errors.sku.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="defaultUnitsPerBox">Unidades por caja</Label>
              <Input
                id="defaultUnitsPerBox"
                type="number"
                min={1}
                {...register("defaultUnitsPerBox", { valueAsNumber: true })}
              />
              {errors.defaultUnitsPerBox && (
                <p className="text-sm text-destructive">{errors.defaultUnitsPerBox.message}</p>
              )}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="name">Nombre</Label>
            <Input id="name" {...register("name")} />
            {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="category">Categoría</Label>
              <Input id="category" {...register("category")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="brand">Marca</Label>
              <Input id="brand" {...register("brand")} />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Códigos de barras</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => append({ value: "", type: "EAN13" })}
              >
                Añadir código
              </Button>
            </div>
            {fields.map((field, index) => (
              <div key={field.id} className="flex items-center gap-2">
                <Input placeholder="Código (EAN/SKU)" {...register(`barcodes.${index}.value` as const)} />
                <Button type="button" variant="ghost" size="sm" onClick={() => remove(index)}>
                  Quitar
                </Button>
              </div>
            ))}
            {errors.barcodes && <p className="text-sm text-destructive">Revisa los códigos introducidos.</p>}
            <p className="text-xs text-muted-foreground">
              Un código con dígito de control inválido igualmente se guarda, marcado para revisión.
            </p>
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
