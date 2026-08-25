"use client";

import { useRouter } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

const ROLES = ["OWNER", "ADMIN", "MANAGER", "COUNTER", "VIEWER"] as const;

interface MemberRowActionsProps {
  membershipId: string;
  role: string;
  isSelf: boolean;
}

export function MemberRowActions({ membershipId, role, isSelf }: MemberRowActionsProps) {
  const router = useRouter();

  async function changeRole(next: string | null) {
    if (!next) return;
    await fetch(`/api/memberships/${membershipId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: next }),
    });
    router.refresh();
  }

  async function remove() {
    if (!confirm("¿Quitar a este miembro de la organización?")) return;
    await fetch(`/api/memberships/${membershipId}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <Select value={role} onValueChange={changeRole} disabled={isSelf}>
        <SelectTrigger className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROLES.map((r) => (
            <SelectItem key={r} value={r}>
              {r}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!isSelf && (
        <Button variant="ghost" size="sm" onClick={remove}>
          Quitar
        </Button>
      )}
    </div>
  );
}
