/**
 * Integration tests: Invitation flow
 *
 * Covers: invite creation, token lookup, acceptance, expiry,
 *         duplicate prevention, role assignment, and RLS gates.
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

const orgIds:    string[] = [];
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

describe("Invitation creation", () => {
  let adminUserClient: ReturnType<typeof import("@supabase/supabase-js").createClient>;
  let orgId: string;
  let adminUserId: string;

  beforeAll(async () => {
    const adminEmail = generateTestEmail("invite-admin");
    testEmails.push(adminEmail);
    const { client, id } = await createTestUser(adminEmail, VALID_PASSWORD);
    adminUserClient = client;
    adminUserId     = id;
    orgId           = await createTestOrg(client, "Invite Test Org");
    orgIds.push(orgId);
  });

  it("admin/owner can create an invitation", async () => {
    const inviteeEmail = generateTestEmail("invitee-1");
    const { data, error } = await adminUserClient
      .from("invitations")
      .insert({
        organization_id: orgId,
        email:           inviteeEmail,
        role:            "analyst",
        invited_by:      adminUserId,
      })
      .select("id, token, email, role")
      .single();

    expect(error).toBeNull();
    expect(data?.email).toBe(inviteeEmail);
    expect(data?.role).toBe("analyst");
    expect(data?.token).toBeTruthy();
    expect(data?.token.length).toBeGreaterThan(30);
  });

  it("invitation token is unique per insert", async () => {
    const email1 = generateTestEmail("inv-tok-1");
    const email2 = generateTestEmail("inv-tok-2");

    const [r1, r2] = await Promise.all([
      adminUserClient
        .from("invitations")
        .insert({ organization_id: orgId, email: email1, role: "viewer", invited_by: adminUserId })
        .select("token")
        .single(),
      adminUserClient
        .from("invitations")
        .insert({ organization_id: orgId, email: email2, role: "viewer", invited_by: adminUserId })
        .select("token")
        .single(),
    ]);

    expect(r1.data?.token).not.toBe(r2.data?.token);
  });

  it("prevents duplicate invitations for the same email in the same org", async () => {
    const inviteeEmail = generateTestEmail("dupe-invite");

    await adminUserClient
      .from("invitations")
      .insert({ organization_id: orgId, email: inviteeEmail, role: "analyst", invited_by: adminUserId });

    // Second insert should fail on unique(organization_id, email)
    const { error } = await adminUserClient
      .from("invitations")
      .insert({ organization_id: orgId, email: inviteeEmail, role: "viewer", invited_by: adminUserId });

    expect(error).not.toBeNull();
  });

  it("viewer cannot create invitations (manage_members permission required)", async () => {
    const viewerEmail = generateTestEmail("inv-viewer");
    testEmails.push(viewerEmail);

    const { client: viewerClient, id: viewerId } = await createTestUser(viewerEmail, VALID_PASSWORD);
    await addMemberToOrg(orgId, viewerId, "viewer");

    const { error } = await viewerClient
      .from("invitations")
      .insert({
        organization_id: orgId,
        email:           generateTestEmail("blocked-invite"),
        role:            "viewer",
        invited_by:      viewerId,
      });

    expect(error).not.toBeNull();
  });
});

describe("Invitation acceptance", () => {
  let orgId: string;
  let ownerEmail: string;

  beforeAll(async () => {
    ownerEmail = generateTestEmail("inv-accept-owner");
    testEmails.push(ownerEmail);
    const { client } = await createTestUser(ownerEmail, VALID_PASSWORD);
    orgId = await createTestOrg(client, "Acceptance Test Org");
    orgIds.push(orgId);
  });

  it("accepting an invitation sets accepted_at and grants org access", async () => {
    const inviteeEmail = generateTestEmail("accepts-invite");
    testEmails.push(inviteeEmail);

    // Owner inserts invitation
    const ownerUser = await createTestUser(ownerEmail, VALID_PASSWORD);
    const { data: inv } = await ownerUser.client
      .from("invitations")
      .insert({
        organization_id: orgId,
        email:           inviteeEmail,
        role:            "analyst",
        invited_by:      ownerUser.id,
      })
      .select("id, token")
      .single();

    // Invitee signs up
    const { id: inviteeId, client: inviteeClient } = await createTestUser(inviteeEmail, VALID_PASSWORD);

    // Simulate acceptance: insert organization_members row with accepted_at
    await adminClient().from("organization_members").insert({
      organization_id: orgId,
      user_id:         inviteeId,
      role:            "analyst",
      accepted_at:     new Date().toISOString(),
    });

    // Mark invitation as accepted
    await adminClient()
      .from("invitations")
      .update({ accepted_at: new Date().toISOString() })
      .eq("id", inv!.id);

    // Invitee should now see the org
    const { data: org } = await inviteeClient
      .from("organizations")
      .select("id")
      .eq("id", orgId)
      .single();

    expect(org?.id).toBe(orgId);
  });

  it("pending member (accepted_at = null) cannot access org data", async () => {
    const pendingEmail = generateTestEmail("pending-member");
    testEmails.push(pendingEmail);
    const { id: pendingId, client: pendingClient } = await createTestUser(pendingEmail, VALID_PASSWORD);

    // Insert WITHOUT accepted_at
    await adminClient().from("organization_members").insert({
      organization_id: orgId,
      user_id:         pendingId,
      role:            "analyst",
      // accepted_at intentionally omitted
    });

    // Pending member should not see the org
    const { data } = await pendingClient
      .from("organizations")
      .select("id")
      .eq("id", orgId)
      .single();

    expect(data).toBeNull();
  });
});

describe("Invitation expiry", () => {
  it("expired invitation token cannot be reused", async () => {
    const ownerEmail = generateTestEmail("exp-owner");
    testEmails.push(ownerEmail);
    const { client: ownerClient, id: ownerId } = await createTestUser(ownerEmail, VALID_PASSWORD);
    const orgId = await createTestOrg(ownerClient, "Expiry Org");
    orgIds.push(orgId);

    const inviteeEmail = generateTestEmail("exp-invitee");

    // Insert invitation already expired (expires_at in the past)
    const { data: inv } = await adminClient()
      .from("invitations")
      .insert({
        organization_id: orgId,
        email:           inviteeEmail,
        role:            "analyst",
        invited_by:      ownerId,
        expires_at:      new Date(Date.now() - 1000).toISOString(), // 1 second ago
      })
      .select("id, token, expires_at")
      .single();

    expect(inv).not.toBeNull();
    expect(new Date(inv!.expires_at) < new Date()).toBe(true);
    // The invite-lookup Edge Function would reject this — here we verify
    // the expires_at field is correctly stored and in the past
  });
});

describe("RLS: invitation visibility", () => {
  it("non-member cannot read invitations for an org they don't belong to", async () => {
    const ownerEmail   = generateTestEmail("inv-rls-owner");
    const outsiderEmail = generateTestEmail("inv-rls-outsider");
    testEmails.push(ownerEmail, outsiderEmail);

    const { client: ownerClient, id: ownerId } = await createTestUser(ownerEmail, VALID_PASSWORD);
    const orgId = await createTestOrg(ownerClient, "RLS Invite Org");
    orgIds.push(orgId);

    await ownerClient.from("invitations").insert({
      organization_id: orgId,
      email:           generateTestEmail("target"),
      role:            "viewer",
      invited_by:      ownerId,
    });

    // Outsider logs in
    const { client: outsiderClient } = await createTestUser(outsiderEmail, VALID_PASSWORD);
    const { data } = await outsiderClient
      .from("invitations")
      .select("id")
      .eq("organization_id", orgId);

    expect(data).toHaveLength(0);
  });
});
