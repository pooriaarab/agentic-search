import { PrincipalParseError, parsePrincipal as checkPrincipal } from "agentic-identity";
import { describe, expect, test, vi } from "vitest";
import { ValidationError } from "./errors.js";
import { parsePrincipal } from "./validate.js";

vi.mock("agentic-identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("agentic-identity")>();
  return { ...actual, parsePrincipal: vi.fn(actual.parsePrincipal) };
});

describe("parsePrincipal", () => {
  test("keeps actingFor for a principal that acts for a subject", () => {
    expect(parsePrincipal({ id: "agent-7", kind: "agent_of_human", actingFor: "alice" })).toEqual({
      id: "agent-7",
      kind: "agent_of_human",
      actingFor: "alice",
    });
  });

  test("keeps actingFor for a user_token principal", () => {
    expect(parsePrincipal({ id: "token-1", kind: "user_token", actingFor: "alice" })).toEqual({
      id: "token-1",
      kind: "user_token",
      actingFor: "alice",
    });
  });

  test("accepts an actingFor at the 256 character edge", () => {
    const subject = "s".repeat(256);
    expect(parsePrincipal({ id: "token-1", kind: "user_token", actingFor: subject }).actingFor).toBe(subject);
    expect(parsePrincipal({ id: "agent-7", kind: "agent_of_human", actingFor: subject }).actingFor).toBe(subject);
  });

  test("accepts ids that start with _ or -", () => {
    expect(parsePrincipal({ id: "_bot", kind: "agent" })).toEqual({ id: "_bot", kind: "agent" });
    expect(parsePrincipal({ id: "-bot", kind: "agent_of_agent" })).toEqual({ id: "-bot", kind: "agent_of_agent" });
    expect(parsePrincipal({ id: "_t-1", kind: "user_token", actingFor: "-alice" })).toEqual({
      id: "_t-1",
      kind: "user_token",
      actingFor: "-alice",
    });
  });

  test("accepts an id at the 128 character edge and agent_of_agent without actingFor", () => {
    expect(parsePrincipal({ id: "a".repeat(128), kind: "human" }).id).toHaveLength(128);
    expect(parsePrincipal({ id: "bot-1", kind: "agent_of_agent" })).toEqual({ id: "bot-1", kind: "agent_of_agent" });
  });

  test("refuses every bad principal with a ValidationError", () => {
    const bad: unknown[] = [
      null,
      "alice",
      [],
      { id: "alice" },
      { kind: "human" },
      { id: 7, kind: "human" },
      { id: "alice", kind: "person" },
      { id: "a", kind: 1 },
      { id: "a", kind: "Human" },
      { id: "", kind: "human" },
      { id: "a@example.com", kind: "human" },
      { id: "zoë", kind: "human" },
      { id: "a:b", kind: "human" },
      { id: "a b", kind: "human" },
      { id: ".hidden", kind: "human" },
      { id: "x".repeat(129), kind: "human" },
      { id: "alice", kind: "human", actingFor: "bob" },
      { id: "agent", kind: "agent", actingFor: "bob" },
      { id: "agent-7", kind: "agent_of_human" },
      { id: "t1", kind: "user_token" },
      { id: "t1", kind: "user_token", actingFor: "" },
      { id: "t1", kind: "user_token", actingFor: 7 },
      { id: "agent-7", kind: "agent_of_human", actingFor: "s".repeat(257) },
      { id: "t1", kind: "user_token", actingFor: "s".repeat(257) },
    ];
    for (const input of bad) {
      expect(() => parsePrincipal(input), JSON.stringify(input)).toThrow(ValidationError);
    }
  });

  test("rethrows a non-PrincipalParseError from the identity check unchanged", () => {
    const boom = new TypeError("identity exploded");
    vi.mocked(checkPrincipal).mockImplementationOnce(() => {
      throw boom;
    });
    let caught: unknown;
    try {
      parsePrincipal({ id: "alice", kind: "human" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(boom);
    expect(caught).not.toBeInstanceOf(ValidationError);
    expect(caught).not.toBeInstanceOf(PrincipalParseError);
  });
});
