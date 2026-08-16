import { assertEquals, assertRejects } from "@std/assert";
import type { FrappeClient } from "./frappe-client.ts";
import { runWithCaller } from "./caller-context.ts";
import {
  clearCallerProfileCache,
  currentUserId,
  isSelfReference,
  loadCallerProfile,
  resolveSelfEmployee,
  resolveSelfUser,
} from "./identity.ts";

// deno-lint-ignore no-explicit-any
type AnyFn = (...args: any[]) => any;

const USER_DOC = {
  name: "khoa.do@havigroup.com",
  email: "khoa.do@havigroup.com",
  full_name: "Do Khoa",
  user_type: "System User",
  enabled: 1,
  time_zone: "Asia/Ho_Chi_Minh",
  language: "vi",
  roles: [
    { role: "Employee" },
    { role: "Projects User" },
    { role: "" },
    { notrole: "ignored" },
  ],
};

const EMPLOYEE_ROW = {
  name: "HR-EMP-00044",
  employee_name: "Do Khoa",
  designation: "Ky su",
  department: "Cong nghe - HVG",
  company: "Havi Group",
  reports_to: "HR-EMP-00001",
  status: "Active",
  date_of_joining: "2024-01-15",
};

function makeClient(overrides: Record<string, AnyFn> = {}): FrappeClient {
  return {
    callMethod: async () => "khoa.do@havigroup.com",
    get: async () => USER_DOC,
    list: async () => [EMPLOYEE_ROW],
    create: async () => ({}),
    update: async () => ({}),
    delete: async () => {},
    ...overrides,
  } as unknown as FrappeClient;
}

Deno.test("currentUserId returns the user Frappe attributed the request to", async () => {
  clearCallerProfileCache();
  assertEquals(await currentUserId(makeClient()), "khoa.do@havigroup.com");
});

Deno.test("currentUserId rejects Guest instead of answering as nobody", async () => {
  clearCallerProfileCache();
  await assertRejects(
    () => currentUserId(makeClient({ callMethod: async () => "Guest" })),
    Error,
    "did not attribute this request to a signed-in user",
  );
});

Deno.test("currentUserId rejects an empty attribution", async () => {
  clearCallerProfileCache();
  await assertRejects(
    () => currentUserId(makeClient({ callMethod: async () => "   " })),
    Error,
    "did not attribute this request to a signed-in user",
  );
});

Deno.test("loadCallerProfile reports user, sorted roles and employee", async () => {
  clearCallerProfileCache();
  const profile = await loadCallerProfile(makeClient());

  assertEquals(profile.user.name, "khoa.do@havigroup.com");
  assertEquals(profile.user.full_name, "Do Khoa");
  assertEquals(profile.user.enabled, true);
  // Blank and malformed child rows are dropped rather than reported as roles.
  assertEquals(profile.roles, ["Employee", "Projects User"]);
  assertEquals(profile.employee?.name, "HR-EMP-00044");
  assertEquals(profile.employee?.department, "Cong nghe - HVG");
});

Deno.test("loadCallerProfile reports a missing Employee as null, not an error", async () => {
  clearCallerProfileCache();
  const profile = await loadCallerProfile(makeClient({ list: async () => [] }));
  assertEquals(profile.employee, null);
});

Deno.test("loadCallerProfile marks a request with no caller as service-account", async () => {
  clearCallerProfileCache();
  const profile = await loadCallerProfile(makeClient());
  assertEquals(profile.identity_mode, "shared-service-account");
});

Deno.test("loadCallerProfile marks a request carrying an identity as per-caller", async () => {
  clearCallerProfileCache();
  const profile = await runWithCaller(
    { accessToken: "token", principal: "khoa.do@havigroup.com" },
    () => loadCallerProfile(makeClient()),
  );
  assertEquals(profile.identity_mode, "per-caller");
});

Deno.test("loadCallerProfile does not serve one caller's profile to another", async () => {
  clearCallerProfileCache();

  const first = await runWithCaller(
    { accessToken: "t1", principal: "khoa.do@havigroup.com" },
    () => loadCallerProfile(makeClient()),
  );
  const second = await runWithCaller(
    { accessToken: "t2", principal: "chi.mai@havigroup.com" },
    () =>
      loadCallerProfile(makeClient({
        callMethod: async () => "chi.mai@havigroup.com",
        get: async () => ({ ...USER_DOC, name: "chi.mai@havigroup.com" }),
      })),
  );

  assertEquals(first.user.name, "khoa.do@havigroup.com");
  assertEquals(second.user.name, "chi.mai@havigroup.com");
});

Deno.test("loadCallerProfile reuses a recent profile for the same principal", async () => {
  clearCallerProfileCache();
  let lookups = 0;
  const client = makeClient({
    callMethod: async () => {
      lookups++;
      return "khoa.do@havigroup.com";
    },
  });

  await runWithCaller(
    { accessToken: "t", principal: "khoa.do@havigroup.com" },
    async () => {
      await loadCallerProfile(client);
      await loadCallerProfile(client);
    },
  );

  assertEquals(lookups, 1);
});

Deno.test("isSelfReference matches only the agreed self words", () => {
  for (const value of ["me", "ME", " Me ", "@me", "self", "myself"]) {
    assertEquals(isSelfReference(value), true, value);
  }
  // A real record whose name merely contains one of them must not be rewritten.
  for (const value of ["Myanmar Trading", "Mehta & Sons", "selfie", ""]) {
    assertEquals(isSelfReference(value), false, value);
  }
});

Deno.test("resolveSelfUser returns the caller's User id", async () => {
  clearCallerProfileCache();
  assertEquals(await resolveSelfUser(makeClient()), "khoa.do@havigroup.com");
});

Deno.test("resolveSelfEmployee returns the caller's Employee id", async () => {
  clearCallerProfileCache();
  assertEquals(await resolveSelfEmployee(makeClient()), "HR-EMP-00044");
});

Deno.test("resolveSelfEmployee refuses to drop the filter when there is no Employee", async () => {
  clearCallerProfileCache();
  await assertRejects(
    () => resolveSelfEmployee(makeClient({ list: async () => [] })),
    Error,
    "has no Employee record",
  );
});
