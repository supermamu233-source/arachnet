"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";

const newProductSchema = z.object({
  sku: z.string().min(1, "El SKU es obligatorio."),
  name: z.string().min(1, "El nombre es obligatorio."),
  category: z.string().optional(),
  brand: z.string().optional(),
});
type NewProductForm = z.infer<typeof newProductSchema>;

interface IntakeDecisionFormProps {
  intakeId: string;
  hasCandidate: boolean;
  suggestedSku?: string;
}

export function IntakeDecisionForm({ intakeId, hasCandidate, suggestedSku }: IntakeDecisionFormProps) {
  const router = useRouter();
  const [mode, setMode] = useState<"link" | "new">(hasCandidate ? "link" : "new");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<NewProductForm>({
    resolver: zodResolver(newProductSchema),
    defaultValues: { sku: suggestedSku ?? "", name: "" },
  });

  async function approve(values?: NewProductForm) {
    setBusy("approve");
    setError(null);
    try {
      const res = await fetch(`/api/product-intakes/${intakeId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "new" && values ? { productDetails: values } : {}),
      });
      const body = await res.json();
      if (body.error) throw new Error(body.error.message);
      router.push("/products");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado.");
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    setBusy("reject");
    setError(null);
    try {
      const res = await fetch(`/api/product-intakes/${intakeId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notes || undefined }),
      });
      const body = await res.json();
      if (body.error) throw new Error(body.error.message);
      router.push("/products");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {hasCandidate && (
        <div className="flex gap-2">
          <Button type="button" variant={mode === "link" ? "default" : "outline"} size="sm" onClick={() => setMode("link")}>
            Vincular al producto existente
          </Button>
          <Button type="button" variant={mode === "new" ? "default" : "outline"} size="sm" onClick={() => setMode("new")}>
            Crear producto nuevo
          </Button>
        </div>
      )}

      {mode === "new" && (
        <form onSubmit={handleSubmit(approve)} className="space-y-3 max-w-sm">
          <div className="space-y-2">
            <Label htmlFor="sku">SKU</Label>
            <Input id="sku" {...register("sku")} />
            {errors.sku && <p className="text-sm text-destructive">{errors.sku.message}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="name">Nombre</Label>
            <Input id="name" {...register("name")} />
            {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="category">Categoría (opcional)</Label>
            <Input id="category" {...register("category")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="brand">Marca (opcional)</Label>
            <Input id="brand" {...register("brand")} />
          </div>
          <Button type="submit" disabled={busy !== null}>
            {busy === "approve" ? "Aprobando…" : "Aprobar y crear producto"}
          </Button>
        </form>
      )}

      {mode === "link" && (
        <Button onClick={() => approve()} disabled={busy !== null}>
          {busy === "approve" ? "Aprobando…" : "Aprobar y vincular"}
        </Button>
      )}

      <Separator />

      <div className="space-y-2 max-w-sm">
        <Label htmlFor="notes">Notas de rechazo (opcional)</Label>
        <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <Button type="button" variant="outline" onClick={reject} disabled={busy !== null}>
          {busy === "reject" ? "Rechazando…" : "Rechazar"}
        </Button>
      </div>
    </div>
  );
}
