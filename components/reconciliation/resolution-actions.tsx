"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface ResolutionActionsProps {
  discrepancyId: string;
  canDismiss: boolean;
}

export function ResolutionActions({ discrepancyId, canDismiss }: ResolutionActionsProps) {
  const router = useRouter();
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState<"resolve" | "dismiss" | null>(null);

  async function act(action: "resolve" | "dismiss") {
    setPending(action);
    try {
      await fetch(`/api/reconciliation/discrepancies/${discrepancyId}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notes || undefined }),
      });
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-3">
      <Textarea
        placeholder="Notas de resolución (opcional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div className="flex gap-2">
        <Button onClick={() => act("resolve")} disabled={pending !== null}>
          {pending === "resolve" ? "Resolviendo…" : "Resolver"}
        </Button>
        {canDismiss && (
          <Button variant="outline" onClick={() => act("dismiss")} disabled={pending !== null}>
            {pending === "dismiss" ? "Descartando…" : "Descartar"}
          </Button>
        )}
      </div>
    </div>
  );
}
