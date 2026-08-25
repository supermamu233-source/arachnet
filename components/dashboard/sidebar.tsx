"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Package,
  MapPin,
  ClipboardList,
  GitCompareArrows,
  Upload,
  Download,
  Bot,
  Users,
  ScrollText,
  Warehouse,
} from "lucide-react";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Panel", icon: LayoutDashboard },
  { href: "/products", label: "Productos", icon: Package },
  { href: "/locations", label: "Ubicaciones", icon: MapPin },
  { href: "/inventory", label: "Conteos", icon: ClipboardList },
  { href: "/reconciliation", label: "Conciliación", icon: GitCompareArrows },
  { href: "/imports", label: "Importaciones", icon: Upload },
  { href: "/exports", label: "Exportaciones", icon: Download },
  { href: "/robots", label: "Robots", icon: Bot },
  { href: "/settings/warehouses", label: "Almacenes", icon: Warehouse },
  { href: "/settings/users", label: "Usuarios", icon: Users },
  { href: "/audit", label: "Auditoría", icon: ScrollText },
];

export function DashboardSidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex h-16 items-center px-6">
        <span className="text-lg font-semibold tracking-tight">Arachnet</span>
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
