import { describe, expect, it } from "vitest";
import { cleanFilters } from "../src/grid/query.js";

describe("cleanFilters", () => {
  it("drops set filters with no values (AG Grid treats them as 'match nothing')", () => {
    const state: Record<string, unknown> = {
      filter: { filterModel: { at: { filterType: "set", values: [] }, status: { filterType: "set", values: ["executed"] }, reason: { filterType: "text" } } },
      rowGroup: { groupColIds: ["customerId"] },
    };
    cleanFilters(state);
    expect(state.filter).toEqual({ filterModel: { status: { filterType: "set", values: ["executed"] } } });
  });

  it("removes the filter section entirely when nothing meaningful is left", () => {
    const state: Record<string, unknown> = { filter: { filterModel: { at: { filterType: "set", values: [] } } } };
    cleanFilters(state);
    expect(state).toEqual({});
  });
});
