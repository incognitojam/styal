import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as Schema from "effect/Schema";

/** The fields of a GitHub Actions run (`GET /repos/{repo}/actions/runs/{id}`) a watch reads. */
const GitHubWorkflowRunSchema = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  run_number: Schema.Int,
  run_attempt: Schema.optional(Schema.Int),
  status: Schema.NullOr(Schema.String),
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  head_branch: Schema.NullOr(Schema.String),
  head_sha: Schema.String,
  event: Schema.String,
});

/** The jobs of a run's latest attempt (`.../runs/{id}/jobs?filter=latest`). */
const GitHubWorkflowRunJobsSchema = Schema.Struct({
  total_count: Schema.Int,
  jobs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      html_url: Schema.NullOr(Schema.String),
    }),
  ),
});

export const decodeGitHubWorkflowRunJson = decodeJsonResult(GitHubWorkflowRunSchema);
export const decodeGitHubWorkflowRunJobsJson = decodeJsonResult(GitHubWorkflowRunJobsSchema);
