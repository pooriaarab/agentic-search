import { describe, expect, test } from "vitest";
import { ValidationError } from "./errors.js";
import { parsePrincipal } from "./validate.js";

describe("parsePrincipal", () => {
  test("keeps actingFor for a principal that acts for a subject", () => {
    expect(parsePrincipal({ id: "agent-7", kind: "agent_of_human", actingFor: "alice" })).toEqual({
      id: "agent-7",
      kind: "agent_of_human",
      actingFor: "alice",
    });
  });

  test("refuses every bad principal with a ValidationError", () => {
    const bad: unknown[] = [
      null,
      "alice",
      [],
      { id: "alice" },
      { id: "alice", kind: "person" },
      { id: "", kind: "human" },
      { id: "a@example.com", kind: "human" },
      { id: ".hidden", kind: "human" },
      { id: "x".repeat(129), kind: "human" },
      { id: "alice", kind: "human", actingFor: "bob" },
      { id: "agent", kind: "agent", actingFor: "bob" },
      { id: "agent-7", kind: "agent_of_human" },
      { id: "t1", kind: "user_token", actingFor: "" },
      { id: "t1", kind: "user_token", actingFor: 7 },
    ];
    for (const input of bad) {
      expect(() => parsePrincipal(input), JSON.stringify(input)).toThrow(ValidationError);
    }
  });
});
