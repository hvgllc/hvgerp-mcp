import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { FrappeAPIError, type FrappeClient } from "./frappe-client.ts";
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
  assertEquals(profile.employee_lookup, "none");
});

Deno.test("loadCallerProfile reports withheld roles as null, never as an empty list", async () => {
  clearCallerProfileCache();
  // The shape measured on production for a caller who holds three roles but no permlevel-1 read:
  // `roles` emptied rather than omitted, `user_type` nulled beside it.
  const profile = await loadCallerProfile(
    makeClient({
      get: async () => ({ ...USER_DOC, roles: [], user_type: null }),
    }),
  );
  assertEquals(profile.roles, null);
});

Deno.test("loadCallerProfile reports a genuinely empty role list as empty", async () => {
  clearCallerProfileCache();
  // Same empty `roles`, but permlevel 1 was readable — `user_type` came through — so the emptiness
  // is Frappe's answer rather than its silence.
  const profile = await loadCallerProfile(
    makeClient({ get: async () => ({ ...USER_DOC, roles: [] }) }),
  );
  assertEquals(profile.roles, []);
});

Deno.test("loadCallerProfile does not read an omitted roles key as withheld on its own", async () => {
  clearCallerProfileCache();
  const { roles: _absent, ...withoutRoles } = USER_DOC;
  const profile = await loadCallerProfile(
    makeClient({ get: async () => withoutRoles }),
  );
  // `user_type` is readable, so nothing was withheld: no roles is the answer, not a refusal.
  assertEquals(profile.roles, []);
});

Deno.test("loadCallerProfile marks a found Employee as found", async () => {
  clearCallerProfileCache();
  const profile = await loadCallerProfile(makeClient());
  assertEquals(profile.employee_lookup, "found");
});

Deno.test("loadCallerProfile still identifies a caller refused the Employee doctype", async () => {
  clearCallerProfileCache();
  const profile = await loadCallerProfile(makeClient({
    list: () => {
      throw new FrappeAPIError("Not permitted for Employee", 403, {});
    },
  }));

  // The point of the whole call is the answer to "who am I", and that answer survives.
  assertEquals(profile.user.name, "khoa.do@havigroup.com");
  assertEquals(profile.roles, ["Employee", "Projects User"]);
  assertEquals(profile.employee, null);
  // Distinct from "none": nothing was established about whether an HR record exists.
  assertEquals(profile.employee_lookup, "forbidden");
});

Deno.test("loadCallerProfile does not absorb a non-permission Employee failure", async () => {
  clearCallerProfileCache();
  await assertRejects(
    () =>
      loadCallerProfile(makeClient({
        list: () => {
          throw new FrappeAPIError("Internal Server Error", 500, {});
        },
      })),
    FrappeAPIError,
    "Internal Server Error",
  );
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

Deno.test("resolveSelfEmployee names the permission, not a missing record, when refused", async () => {
  clearCallerProfileCache();
  const error = await assertRejects(
    () =>
      resolveSelfEmployee(makeClient({
        list: () => {
          throw new FrappeAPIError("Not permitted for Employee", 403, {});
        },
      })),
    Error,
  );

  assertStringIncludes(error.message, "may not read the Employee doctype");
  // Sending this caller to HR to have a record created would be the wrong door.
  assertEquals(error.message.includes("has no Employee record"), false);
});

Deno.test("loadCallerProfile does not serve one client's profile to another", async () => {
  clearCallerProfileCache();
  let firstCalls = 0;
  const first = makeClient({
    callMethod: async () => {
      firstCalls++;
      return "khoa.do@havigroup.com";
    },
  });
  const second = makeClient({
    callMethod: async () => "huong.ngo@havigroup.com",
    get: async () => ({
      ...USER_DOC,
      name: "huong.ngo@havigroup.com",
      email: "huong.ngo@havigroup.com",
      full_name: "Ngo Huong",
    }),
    list: async () => [{
      ...EMPLOYEE_ROW,
      name: "HR-EMP-00007",
      employee_name: "Ngo Huong",
    }],
  });

  assertEquals(
    (await loadCallerProfile(first)).user.name,
    "khoa.do@havigroup.com",
  );

  // Neither client carries a caller identity, so the principal half of the key is the very
  // same string for both of them. `mod.ts` exports `setFrappeClient`, so an embedder can
  // point a second client at a second ERPNext site: keyed on the principal alone, that
  // second site was answered with the first site's User and Employee ID for a full TTL.
  const other = await loadCallerProfile(second);
  assertEquals(other.user.name, "huong.ngo@havigroup.com");
  assertEquals(other.employee?.name, "HR-EMP-00007");

  // Control: partitioning must not turn the cache off. The first client answers from memory.
  assertEquals(
    (await loadCallerProfile(first)).user.name,
    "khoa.do@havigroup.com",
  );
  assertEquals(firstCalls, 1);
});
