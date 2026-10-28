import { Schema } from "effect";

/**
 * Vercel region code such as `iad1`.
 *
 * Accepts any code of the documented shape, not only the regions listed in
 * {@link knownVercelRegions}, because Vercel adds regions without SDK releases.
 */
export const VercelRegion = Schema.String.check(Schema.isPattern(/^[a-z]{3}\d+$/)).pipe(
  Schema.brand("VercelRegion"),
);

/** Vercel region code such as `iad1`. */
export type VercelRegion = typeof VercelRegion.Type;

/** Region codes Vercel documents today; a hint for defaults and docs, never a validation list. */
export const knownVercelRegions = [
  "arn1",
  "bom1",
  "cdg1",
  "cle1",
  "cpt1",
  "dub1",
  "dxb1",
  "fra1",
  "gru1",
  "hkg1",
  "hnd1",
  "iad1",
  "icn1",
  "kix1",
  "lhr1",
  "pdx1",
  "sfo1",
  "sin1",
  "syd1",
  "yul1",
] as const;

/** Identifier of one Vercel deployment, as exposed in `VERCEL_DEPLOYMENT_ID` (`dpl_…`). */
export const DeploymentId = Schema.NonEmptyString.pipe(Schema.brand("DeploymentId"));

/** Identifier of one Vercel deployment (`dpl_…`). */
export type DeploymentId = typeof DeploymentId.Type;

/** Identifier of a Vercel project (`prj_…`). */
export const ProjectId = Schema.NonEmptyString.pipe(Schema.brand("ProjectId"));

/** Identifier of a Vercel project (`prj_…`). */
export type ProjectId = typeof ProjectId.Type;

/** Identifier of a Vercel team (`team_…`). */
export const TeamId = Schema.NonEmptyString.pipe(Schema.brand("TeamId"));

/** Identifier of a Vercel team (`team_…`). */
export type TeamId = typeof TeamId.Type;

/** Deployment target (`VERCEL_ENV`), named `target` in the Vercel REST API. */
export const VercelTarget = Schema.Literals(["production", "preview", "development"]);

/** Deployment target: production, preview or development. */
export type VercelTarget = typeof VercelTarget.Type;
