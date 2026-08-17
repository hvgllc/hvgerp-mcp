import { assertEquals } from "@std/assert";
import { getErrorPresentation } from "./presentation.ts";

Deno.test("viewer presentation - an error with no data blocks the whole view", () => {
  assertEquals(
    getErrorPresentation({
      data: null,
      error:
        "The tool returned a doclist payload with no rows array. This is a broken response, not an empty result - ask again.",
    }),
    {
      blockingError:
        "The tool returned a doclist payload with no rows array. This is a broken response, not an empty result - ask again.",
      inlineError: null,
    },
  );
});

Deno.test("viewer presentation - an error over existing data stays inline", () => {
  assertEquals(
    getErrorPresentation({ data: { count: 3 }, error: "Refresh failed" }),
    { blockingError: null, inlineError: "Refresh failed" },
  );
});

Deno.test("viewer presentation - no error means no message either way", () => {
  assertEquals(
    getErrorPresentation({ data: null, error: null }),
    { blockingError: null, inlineError: null },
  );
  assertEquals(
    getErrorPresentation({ data: { count: 0 }, error: null }),
    { blockingError: null, inlineError: null },
  );
});
