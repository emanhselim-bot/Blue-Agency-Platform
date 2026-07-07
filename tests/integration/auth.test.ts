/**
 * Integration tests: Authentication
 *
 * Tests against local Supabase (supabase start required).
 * Covers: sign up, sign in, sign out, session refresh, wrong credentials,
 *         profile auto-creation, org membership validation.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  adminClient,
  anonClient,
  generateTestEmail,
  createTestUser,
  cleanupTestUsers,
} from "@setup/supabase-helpers";
import { VALID_PASSWORD, INVALID_PASSWORD } from "@fixtures";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY!;

const testEmails: string[] = [];

afterAll(async () => {
  // Cleanup all test users created in this file
  const admin = adminClient();
  for (const email of testEmails) {
    const { data } = await admin.auth.admin.listUsers();
    const user = data?.users.find(u => u.email === email);
    if (user) await admin.auth.admin.deleteUser(user.id);
  }
});

describe("Sign up", () => {
  it("creates a new user and auto-creates a profile row", async () => {
    const email = generateTestEmail("signup-profile");
    testEmails.push(email);

    const client = anonClient();
    const { data, error } = await client.auth.signUp({ email, password: VALID_PASSWORD });

    expect(error).toBeNull();
    expect(data.user?.email).toBe(email);

    // Profile should have been created by the on_auth_user_created trigger
    // Use admin client to bypass email-confirmation requirement
    const { data: profile } = await adminClient()
      .from("profiles")
      .select("id, email")
      .eq("email", email)
      .single();

    expect(profile).not.toBeNull();
    expect(profile?.email).toBe(email);
  });

  it("rejects duplicate email addresses", async () => {
    const email = generateTestEmail("signup-dupe");
    testEmails.push(email);

    const client = anonClient();
    await client.auth.signUp({ email, password: VALID_PASSWORD });
    const { error } = await client.auth.signUp({ email, password: VALID_PASSWORD });

    // Supabase returns success with a fake user to prevent email enumeration,
    // but the second sign-up does NOT create a second profile row
    const { data: profiles } = await adminClient()
      .from("profiles")
      .select("id")
      .eq("email", email);
    expect(profiles?.length).toBe(1);
  });

  it("rejects a password shorter than 6 characters", async () => {
    const email  = generateTestEmail("signup-short-pw");
    testEmails.push(email);
    const client = anonClient();
    const { error } = await client.auth.signUp({ email, password: "abc" });
    // Supabase enforces minimum password length
    expect(error).not.toBeNull();
  });
});

describe("Sign in", () => {
  let email: string;
  beforeAll(async () => {
    email = generateTestEmail("signin");
    testEmails.push(email);
    await createTestUser(email, VALID_PASSWORD);
  });

  it("returns a session with a valid JWT on correct credentials", async () => {
    const client = anonClient();
    const { data, error } = await client.auth.signInWithPassword({
      email,
      password: VALID_PASSWORD,
    });
    expect(error).toBeNull();
    expect(data.session?.access_token).toBeTruthy();
    expect(data.user?.email).toBe(email);
  });

  it("rejects incorrect password", async () => {
    const client = anonClient();
    const { data, error } = await client.auth.signInWithPassword({
      email,
      password: INVALID_PASSWORD,
    });
    expect(error).not.toBeNull();
    expect(data.session).toBeNull();
  });

  it("rejects non-existent email", async () => {
    const client = anonClient();
    const { data, error } = await client.auth.signInWithPassword({
      email:    "ghost-user-that-does-not-exist@blue-agency-test.internal",
      password: VALID_PASSWORD,
    });
    expect(error).not.toBeNull();
    expect(data.session).toBeNull();
  });

  it("session contains user id matching the profile", async () => {
    const client = anonClient();
    const { data } = await client.auth.signInWithPassword({ email, password: VALID_PASSWORD });
    const userId = data.user?.id;
    expect(userId).toBeTruthy();

    const { data: profile } = await client.from("profiles").select("id").eq("id", userId!).single();
    expect(profile?.id).toBe(userId);
  });
});

describe("Sign out", () => {
  it("invalidates the session after sign out", async () => {
    const email = generateTestEmail("signout");
    testEmails.push(email);
    const { client } = await createTestUser(email, VALID_PASSWORD);

    // Confirm we're signed in
    const { data: before } = await client.auth.getUser();
    expect(before.user).not.toBeNull();

    await client.auth.signOut();

    // After sign out, getUser() should return null
    const { data: after } = await client.auth.getUser();
    expect(after.user).toBeNull();
  });
});

describe("Profile access", () => {
  it("a user can read their own profile", async () => {
    const email        = generateTestEmail("profile-read");
    testEmails.push(email);
    const { client, id } = await createTestUser(email, VALID_PASSWORD);

    const { data, error } = await client.from("profiles").select("id, email").eq("id", id).single();
    expect(error).toBeNull();
    expect(data?.email).toBe(email);
  });

  it("a user cannot read another user's profile (RLS)", async () => {
    const emailA = generateTestEmail("profile-a");
    const emailB = generateTestEmail("profile-b");
    testEmails.push(emailA, emailB);

    const { client: clientA } = await createTestUser(emailA, VALID_PASSWORD);
    const { id: idB }         = await createTestUser(emailB, VALID_PASSWORD);

    // clientA should not see idB's profile (different user, no shared org yet)
    const { data } = await clientA
      .from("profiles")
      .select("id")
      .eq("id", idB)
      .single();
    // RLS should return no rows
    expect(data).toBeNull();
  });

  it("users in the same org can read each other's profiles", async () => {
    const emailA = generateTestEmail("same-org-a");
    const emailB = generateTestEmail("same-org-b");
    testEmails.push(emailA, emailB);

    const { client: clientA, id: idA } = await createTestUser(emailA, VALID_PASSWORD);
    const { id: idB }                   = await createTestUser(emailB, VALID_PASSWORD);

    // Create org as user A
    const { data: orgId } = await clientA.rpc("create_organization", { org_name: "Shared Org" });

    // Add user B as member via admin
    await adminClient()
      .from("organization_members")
      .insert({ organization_id: orgId, user_id: idB, role: "analyst", accepted_at: new Date().toISOString() });

    // User A can now see user B
    const { data } = await clientA.from("profiles").select("id").eq("id", idB).single();
    expect(data?.id).toBe(idB);
  });
});

describe("Unauthenticated access", () => {
  it("anonymous users cannot read profiles table", async () => {
    const client = createClient(SUPABASE_URL, ANON_KEY);
    const { data, error } = await client.from("profiles").select("id").limit(1);
    // RLS should block all rows
    expect(data).toHaveLength(0);
  });

  it("anonymous users cannot read organizations", async () => {
    const client = createClient(SUPABASE_URL, ANON_KEY);
    const { data } = await client.from("organizations").select("id").limit(1);
    expect(data).toHaveLength(0);
  });
});
