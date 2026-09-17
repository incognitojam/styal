import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { LegacyImportPreview, LegacyImportResult } from "./dataImport.ts";

const decodePreview = Schema.decodeUnknownSync(LegacyImportPreview);
const decodeResult = Schema.decodeUnknownSync(LegacyImportResult);

describe.each(["t3-code", "t3-code-yngatech"])("import responses from %s servers", (sourceKind) => {
  it("decodes an available preview with older response fields", () => {
    const project = {
      projectId: "project-import",
      title: "Imported project",
      workspaceRoot: "/work/import",
      faviconPath: null,
      threadCount: 1,
      scriptCount: 0,
      isExistingProject: false,
    };

    expect(
      decodePreview({
        status: "available",
        sourceKind,
        schemaVersion: 39,
        projects: [project],
      }),
    ).toEqual({
      status: "available",
      sourceKind,
      schemaVersion: 39,
      projects: [{ ...project, contextRepairCount: 0 }],
    });
  });

  it("decodes a completed import with older response fields", () => {
    const result = {
      sourceKind,
      projects: [
        {
          sourceProjectId: "project-import",
          targetProjectId: "project-import",
          title: "Imported project",
          status: "imported",
          threadCount: 1,
          skippedAttachmentCount: 0,
        },
      ],
      importedProjectCount: 1,
      importedThreadCount: 1,
      skippedAttachmentCount: 0,
    };

    expect(decodeResult(result)).toEqual({
      ...result,
      projects: [{ ...result.projects[0], repairedThreadCount: 0 }],
      repairedThreadCount: 0,
    });
  });
});
