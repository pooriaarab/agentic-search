import { subjectOf } from "./validate.js";
import type { AccessPolicy } from "./types.js";

/**
 * Default policy: a principal reads and writes only what its subject owns.
 * Apps with sharing inject their own policy on the same port.
 */
export const ownerPolicy: AccessPolicy = {
  async canRead(principal, refs) {
    const subject = subjectOf(principal);
    return refs.map((r) => r.owner === subject);
  },
  async canWrite(principal, ref) {
    return ref.owner === subjectOf(principal);
  },
  async canManageOwner(principal, owner) {
    return owner === subjectOf(principal);
  },
};
