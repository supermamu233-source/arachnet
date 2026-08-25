"use client";

import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { LogOut } from "lucide-react";

interface TopbarProps {
  organizationName: string;
  userName: string;
  role: string;
}

export function DashboardTopbar({ organizationName, userName, role }: TopbarProps) {
  const router = useRouter();

  async function handleSignOut() {
    await signOut();
    router.push("/login");
    router.refresh();
  }

  const initials = userName
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <header className="flex h-16 items-center justify-between border-b border-border bg-background px-6">
      <div>
        <p className="text-sm font-medium text-foreground">{organizationName}</p>
      </div>
      <div className="flex items-center gap-3">
        <Badge variant="secondary">{role}</Badge>
        <Avatar className="h-8 w-8">
          <AvatarFallback className="text-xs">{initials || "?"}</AvatarFallback>
        </Avatar>
        <span className="hidden text-sm text-muted-foreground sm:inline">{userName}</span>
        <Button variant="ghost" size="icon" onClick={handleSignOut} aria-label="Cerrar sesión">
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
