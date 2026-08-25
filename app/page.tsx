import { redirect } from "next/navigation";
import { getAuthContext } from "@/server/auth/session";

export default async function RootPage() {
  const context = await getAuthContext();
  redirect(context ? "/dashboard" : "/login");
}
