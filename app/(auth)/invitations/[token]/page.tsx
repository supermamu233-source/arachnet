"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";

const schema = z.object({
  name: z.string().min(1, "Introduce tu nombre."),
  password: z.string().min(12, "Debe tener al menos 12 caracteres."),
});
type FormValues = z.infer<typeof schema>;

interface InvitationInfo {
  email: string;
  role: string;
  status: string;
  organization: { name: string };
}

export default function AcceptInvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const [invitation, setInvitation] = useState<InvitationInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  useEffect(() => {
    fetch(`/api/invitations/${token}/accept`)
      .then((res) => res.json())
      .then((body) => {
        if (body.error) {
          setLoadError(body.error.message);
        } else {
          setInvitation(body.data);
        }
      })
      .catch(() => setLoadError("No se pudo cargar la invitación."));
  }, [token]);

  async function onSubmit(values: FormValues) {
    setServerError(null);
    const res = await fetch(`/api/invitations/${token}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    const body = await res.json();
    if (body.error) {
      setServerError(body.error.message);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  if (loadError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Invitación no válida</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  if (!invitation) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Únete a {invitation.organization.name}</CardTitle>
        <CardDescription>
          Crea tu cuenta para {invitation.email} con el rol {invitation.role}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {serverError && (
            <Alert variant="destructive">
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="name">Nombre completo</Label>
            <Input id="name" autoComplete="name" {...register("name")} />
            {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Contraseña</Label>
            <Input id="password" type="password" autoComplete="new-password" {...register("password")} />
            {errors.password && <p className="text-sm text-destructive">{errors.password.message}</p>}
          </div>
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Creando cuenta…" : "Crear cuenta"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
