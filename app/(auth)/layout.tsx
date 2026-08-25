export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="text-2xl font-semibold tracking-tight text-primary">Arachnet</span>
          <p className="mt-1 text-sm text-muted-foreground">
            Verificación de inventario físico
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}
