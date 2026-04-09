import { z } from "zod";

export const PROVENANCE_MANIFEST_SCHEMA_VERSION = 1 as const;

export const ProvenanceManifestSchema = z.object({
  schemaVersion: z.literal(PROVENANCE_MANIFEST_SCHEMA_VERSION),
  sessionId: z.string(),
  loopGitSha: z.string(),
  repoGitSha: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  costTableVersion: z.string(),
  piMdDigest: z.string().nullable(),
  policyDigest: z.string(),
  createdAt: z.string(),
});

export type ProvenanceManifest = z.infer<typeof ProvenanceManifestSchema>;
