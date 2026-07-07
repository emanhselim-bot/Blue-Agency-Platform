/**
 * Integration tests: Organization management
 *
 * Covers: create org, membership roles, settings, subscription auto-creation,
 *         slug generation, permission gates.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  adminClient,
  generateTestEmail,
  createTestUser,
  createTestOrg,
  addMemberToOrg,
  cleanupTestOrgs,
} from "@setup/supabase-helpers";
import { VALID_PASSWORD } from "@fixtures";

const orgIds: string[] = [];
const testEmails: string[] = [];

afterAll(async () => {
  await cleanupTestOrgs(orgIds);
  const admin = adminClient();
  for (const email of testEmails) {
    const { data } = await admin.auth.admin.listUsers();
    const user = data?.users.find(u => u.email === email);
    if (user) await admin.auth.admin.deleteUser(user.id);
  }
});

describe("Organization creation", () => {
  it("creates an org and returns a UUID", async () => {
    const email = generateTestEmail("org-create");
    testEmails.push(email);
    const { client } = await createTestUser(email, VALID_PASSWORD);

    const { data: orgId, error } = await client.rpc("create_organization", {
      org_name: "Test Agency Alpha",
    });

    expect(error).toBeNull();
    expect(typeof orgId).toBe("string");
    expect(orgId.length).toBeGreaterThan(10);
    orgIds.push(orgId);
  });

  it("automatically makes the creator an owner with accepted membership", async () => {
    const email = generateTestEmail("org-owner");
    testEmails.push(email);
    const { client, id: userId } = await createTestUser(email, VALID_PASSWORD);

    const orgId = await createTestOrg(client, "Creator Is Owner");
    orgIds.push(orgId);

    const { data: member } = await adminClient()
      .from("organization_members")
      .select("role, accepted_at")
      .eq("organization_id", orgId)
      .eq("user_id", userId)
      .single();

    expect(member?.role).toBe("owner");
    expect(member?.accepted_at).not.toBeNull();
  });

  it("auto-creates a free subscription on org creation", async () => {
    const email = generateTestEmail("org-subscription");
    testEmails.push(email);
    const { client } = await createTestUser(email, VALID_PASSWORD);

    const orgId = await createTestOrg(client, "New Org With Sub");
    orgIds.push(orgId);

    const { data: sub } = await adminClient()
      .from("organization_subscriptions")
      .select("plan_id, status")
      .eq("organization_id", orgId)
      .single();

    expect(sub?.plan_id).toBe("free");
    expect(sub?.status).toBe("active");
  });

  it("auto-creates org_settings row on creation", async () => {
    const email = generateTestEmail("org-settings");
    testEmails.push(email);
    const { client } = await createTestUser(email, VALID_PASSWORD);

    const orgId = await createTestOrg(client, "Org With Settings");
    orgIds.push(orgId);

    const { data: settings } = await adminClient()
      .from("organization_settings")
      .select("organization_id, default_currency")
      .eq("organization_id", orgId)
      .single();

    expect(settings?.organization_id).toBe(orgId);
    expect(settings?.default_currency).toBe("USD");
  });

  it("generates a unique URL slug from the org name", async () => {
    const email = generateTestEmail("org-slug");
    testEmails.push(email);
    const { client } = await createTestUser(email, VALID_PASSWORD);

    const orgId = await createTestOrg(client, "Slug Test Agency");
    orgIds.push(orgId);

    const { data: org } = await adminClient()
      .from("organizations")
      .select("slug")
      .eq("id", orgId)
      .single();

    expect(org?.slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("two orgs with the same name get different slugs", async () => {
    const emailA = generateTestEmail("slug-a");
    const emailB = generateTestEmail("slug-b");
    testEmails.push(emailA, emailB);

    const { client: clientA } = await createTestUser(emailA, VALID_PASSWORD);
    const { client: clientB } = await createTestUser(emailB, VALID_PASSWORD);

    const orgAId = await createTestOrg(clientA, "Duplicate Name");
    const orgBId = await createTestOrg(clientB, "Duplicate Name");
    orgIds.push(orgAId, orgBId);

    const { data: orgs } = await adminClient()
      .from("organizations")
      .select("slug")
      .in("id", [orgAId, orgBId]);

    const slugs = orgs?.map(o => o.slug) ?? [];
    expect(new Set(slugs).size).toBe(2); // must be different
  });

  it("rejects empty org name", async () => {
    const email = generateTestEmail("org-empty-name");
    testEmails.push(email);
    const { client } = await createTestUser(email, VALID_PASSWORD);

    const { error } = await client.rpc("create_organization", { org_name: "   " });
    expect(error).not.toBeNull();
  });
});

describe("Organization membership", () => {
  let ownerEmail: string;
  let analystEmail: string;
  let orgId: string;
  let ownerId: string;
  let analystId: string;

  beforeAll(async () => {
    ownerEmail   = generateTestEmail("member-owner");
    analystEmail = generateTestEmail("member-analyst");
    testEmails.push(ownerEmail, analystEmail);

    const { client: ownerClient, id } = await createTestUser(ownerEmail, VALID_PASSWORD);
    ownerId = id;
    orgId   = await createTestOrg(ownerClient, "Membership Test Org");
    orgIds.push(orgId);

    const analystUser = await createTestUser(analystEmail, VALID_PASSWORD);
    analystId = analystUser.id;
    await addMemberToOrg(orgId, analystId, "analyst");
  });

  it("owner can read their own org", async () => {
    const { client } = await createTestUser(ownerEmail, VALID_PASSWORD);
    const { data }   = await client.from("organizations").select("id").eq("id", orgId).single();
    expect(data?.id).toBe(orgId);
  });

  it("analyst can read the org they belong to", async () => {
    const analystClient = (await createTestUser(analystEmail, VALID_PASSWORD)).client;
    const { data } = await analystClient
      .from("organizations")
      .select("id")
      .eq("id", orgId)
      .single();
    expect(data?.id).toBe(orgId);
  });

  it("user not in org cannot see it (RLS)", async () => {
    const outsiderEmail = generateTestEmail("outsider");
    testEmails.push(outsiderEmail);
    const { client } = await createTestUser(outsiderEmail, VALID_PASSWORD);

    const { data } = await client
      .from("organizations")
      .select("id")
      .eq("id", orgId)
      .single();
    expect(data).toBeNull();
  });
});

describe("Role-based permissions", () => {
  let orgId: string;
  let ownerClient: ReturnType<typeof import("@supabase/supabase-js").createClient>;
  let viewerClient: ReturnType<typeof import("@supabase/supabase-js").createClient>;

  beforeAll(async () => {
    const ownerEmail  = generateTestEmail("perm-owner");
    const viewerEmail = generateTestEmail("perm-viewer");
    testEmails.push(ownerEmail, viewerEmail);

    const owner = await createTestUser(ownerEmail, VALID_PASSWORD);
    ownerClient = owner.client;
    orgId       = await createTestOrg(ownerClient, "Permission Test Org");
    orgIds.push(orgId);

    const viewer = await createTestUser(viewerEmail, VALID_PASSWORD);
    viewerClient = viewer.client;
    await addMemberToOrg(orgId, viewer.id, "viewer");
  });

  it("owner can read org settings", async () => {
    const { data, error } = await ownerClient
      .from("organization_settings")
      .select("organization_id")
      .eq("organization_id", orgId)
      .single();
    expect(error).toBeNull();
    expect(data?.organization_id).toBe(orgId);
  });

  it("viewer can read org settings (read permission)", async () => {
    const { data } = await viewerClient
      .from("organization_settings")
      .select("organization_id")
      .eq("organization_id", orgId)
      .single();
    expect(data?.organization_id).toBe(orgId);
  });

  it("viewer cannot update org settings (manage_settings required)", async () => {
    const { error } = await viewerClient
      .from("organization_settings")
      .update({ default_currency: "EUR" })
      .eq("organization_id", orgId);
    expect(error).not.toBeNull();
  });

  it("owner can read audit log entries for their org", async () => {
    // Insert a test audit log entry via admin
    await adminClient().from("audit_log").insert({
      organization_id: orgId,
      action:          "test.action",
      resource_type:   "test",
    });

    const { data } = await ownerClient
      .from("audit_log")
      .select("action")
      .eq("organization_id", orgId)
      .eq("action", "test.action");
    expect(data?.length).toBeGreaterThan(0);
  });

  it("viewer in org can read audit log", async () => {
    const { data } = await viewerClient
      .from("audit_log")
      .select("action")
      .eq("organization_id", orgId)
      .limit(5);
    expect(data).not.toBeNull();
  });
});
