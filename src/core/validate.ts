import { PrincipalParseError, parsePrincipal as checkPrincipal } from "agentic-identity";
import { ValidationError } from "./errors.js";
import {
  ITEM_KINDS,
  type IndexedItem,
  type ItemFilter,
  type ItemKind,
  type Principal,
} from "./types.js";

export const LIMITS = {
  id: 256,
  title: 1_000,
  text: 500_000,
  query: 500,
  terms: 16,
  maxPageSize: 100,
  defaultPageSize: 20,
  batch: 500,
  reindex: 10_000,
} as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof v !== "string") throw new ValidationError(`${field} must be a string`);
  if (!allowEmpty && v.length === 0) throw new ValidationError(`${field} must not be empty`);
  if (v.length > max) throw new ValidationError(`${field} is longer than ${max}`);
  return v;
}

function epoch(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`);
  }
  return v;
}

export function isItemKind(v: unknown): v is ItemKind {
  return typeof v === "string" && (ITEM_KINDS as readonly string[]).includes(v);
}

export function parseItem(input: unknown): IndexedItem {
  if (!isRecord(input)) throw new ValidationError("item must be an object");
  const resource = input.resource;
  if (!isRecord(resource)) throw new ValidationError("resource must be an object");
  if (!isItemKind(input.kind)) {
    throw new ValidationError(`kind must be one of ${ITEM_KINDS.join(", ")}`);
  }
  return {
    id: str(input.id, "id", LIMITS.id),
    kind: input.kind,
    title: str(input.title, "title", LIMITS.title, true),
    text: str(input.text, "text", LIMITS.text, true),
    owner: str(input.owner, "owner", LIMITS.id),
    resource: {
      type: str(resource.type, "resource.type", LIMITS.id),
      id: str(resource.id, "resource.id", LIMITS.id),
    },
    updatedAt: epoch(input.updatedAt, "updatedAt"),
  };
}

export function parseFilter(input: Record<string, unknown>): ItemFilter {
  const out: ItemFilter = {};
  if (input.kinds !== undefined) {
    if (!Array.isArray(input.kinds) || input.kinds.length === 0 || !input.kinds.every(isItemKind)) {
      throw new ValidationError(`kinds must be a non-empty list of ${ITEM_KINDS.join(", ")}`);
    }
    out.kinds = [...new Set(input.kinds as ItemKind[])];
  }
  if (input.owner !== undefined) out.owner = str(input.owner, "owner", LIMITS.id);
  if (input.resource !== undefined) {
    if (!isRecord(input.resource)) throw new ValidationError("resource must be an object");
    out.resource = { type: str(input.resource.type, "resource.type", LIMITS.id) };
    if (input.resource.id !== undefined) {
      out.resource.id = str(input.resource.id, "resource.id", LIMITS.id);
    }
  }
  if (input.updatedAfter !== undefined) out.updatedAfter = epoch(input.updatedAfter, "updatedAfter");
  if (input.updatedBefore !== undefined) out.updatedBefore = epoch(input.updatedBefore, "updatedBefore");
  return out;
}

/**
 * Kind and id come from agentic-identity, so every package checks them the same way.
 * This adds the subject rules that `agentic-identity` does not check.
 */
export function parsePrincipal(input: unknown): Principal {
  let ref: { id: string; kind: Principal["kind"] };
  try {
    ref = checkPrincipal(input);
  } catch (error) {
    if (error instanceof PrincipalParseError) throw new ValidationError(error.message);
    throw error;
  }
  const { kind } = ref;
  const principal: Principal = { id: ref.id, kind };
  const { actingFor } = input as Record<string, unknown>;
  if (actingFor !== undefined) {
    if (kind === "human" || kind === "agent") {
      throw new ValidationError(`${kind} principal cannot carry actingFor`);
    }
    principal.actingFor = str(actingFor, "principal.actingFor", LIMITS.id);
  }
  if (
    (principal.kind === "agent_of_human" || principal.kind === "user_token") &&
    principal.actingFor === undefined
  ) {
    throw new ValidationError(`${principal.kind} principal needs actingFor`);
  }
  return principal;
}

/** The subject whose data a principal may touch by default. */
export function subjectOf(principal: Principal): string {
  return principal.actingFor ?? principal.id;
}

export function parseLimit(v: unknown): number {
  if (v === undefined) return LIMITS.defaultPageSize;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > LIMITS.maxPageSize) {
    throw new ValidationError(`limit must be an integer from 1 to ${LIMITS.maxPageSize}`);
  }
  return v;
}
