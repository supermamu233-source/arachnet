import { requireRole } from "@/server/auth/session";
import { getOrganization } from "@/server/services/organization";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OrganizationForm } from "@/components/settings/organization-form";

export default async function SettingsOrganizationPage() {
  const context = await requireRole("ADMIN");
  const organization = await getOrganization(context.organizationId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Organización</h1>
        <p className="text-sm text-muted-foreground">Configuración general del inquilino.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Datos generales</CardTitle>
        </CardHeader>
        <CardContent>
          <OrganizationForm
            initial={{ name: organization.name, timezone: organization.timezone, locale: organization.locale }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
