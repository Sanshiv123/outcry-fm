import { env } from "../env.ts";
import { tmFetch } from "./client.ts";
import { organizationId } from "./token.ts";
import type { OrganizationUser, Page } from "./types.ts";

export async function getSoleOrganizationUser(): Promise<OrganizationUser> {
  if (env.MOCK_MODE || !env.TM_LINK_EXISTING_USER) throw new Error("Existing Gateway user linking is not enabled");
  const orgId = await organizationId();
  const page = await tmFetch<Page<OrganizationUser>>(`/v1/account/organizations/${orgId}/users?limit=2`);
  if (page.data.length !== 1 || page.pagination.next_cursor) {
    throw new Error("Existing wallet linking requires exactly one Gateway user in the organization");
  }
  return page.data[0]!;
}
