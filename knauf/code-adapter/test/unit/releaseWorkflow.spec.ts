import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(process.cwd(), '../../.github/workflows/deploy-code-adapter.yaml'),
  'utf8',
);

describe('code-adapter nonprod delivery workflow', () => {
  it('runs asynchronously from successful main builds and consumes immutable provenance', () => {
    expect(workflow).toContain('workflow_run:');
    expect(workflow).toContain('workflows: [Build code-adapter image]');
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(workflow).toContain('pattern: code-adapter-*-provenance');
    expect(workflow).toContain('[ "$IMAGE" = "$ACR_NAME.azurecr.io/$IMAGE_REPOSITORY@$DIGEST" ]');
    expect(workflow).not.toContain('workflow_dispatch:');
  });

  it('pins digest-capable GitOps and promotes dev before stage', () => {
    expect(workflow).toContain('MIN_CT_SHARED_CHART_VERSION: 2.17.0');
    expect(workflow).toContain('print indent "digest: \\"" digest "\\""');
    expect(workflow).toContain('gh pr merge "$pr_url" --auto --squash --delete-branch');
    expect(workflow).toContain('gh pr merge "$pr_url" --squash --delete-branch >/dev/null');
    expect(workflow).toMatch(/deploy_environment dev\s+deploy_environment stage/);
    expect(workflow).toContain('grep -Fx "$EXPECTED_IMAGE"');
    expect(workflow).toContain('has neither image.tag nor image.digest');
  });

  it('does not automate production or erase the manual rollback path', () => {
    expect(workflow).not.toContain('agentic-karl/prod/services');
    expect(workflow).not.toContain('acr-agk-hub-prod');
    expect(workflow).toContain('Rollback remains a reviewed GitOps revert');
    expect(workflow).toContain('previous version/digest remains in ACR and Git history');
    expect(workflow).not.toContain('build_run_id:');
  });
});
