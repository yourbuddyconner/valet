import { createFileRoute } from "@tanstack/react-router";
import { useOrg, usePatchOrgSettings } from "~/api/settings";
import { Switch } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { SourcesSection } from "~/components/settings/sources-section";

/**
 * `/settings/organization/sandbox-images` — Organization · Sandbox settings
 * (sandbox-reconciliation plan, Task 18). Three groups on one page: base
 * image, repository images, external images. Renders inside
 * `/settings/organization`'s `OrgRouteGuard` — no per-page admin re-check.
 */
export const Route = createFileRoute("/settings/organization/sandbox-images")({
  component: OrganizationSandboxSettingsPage,
});

export function OrganizationSandboxSettingsPage() {
  const org = useOrg();
  const patch = usePatchOrgSettings();
  return (
    <div className="space-y-10">
      <Section title="Anonymous image bakes" description="Allow public repository images to build without an org GitHub credential. Off by default.">
        <div className="flex items-center justify-between gap-4 py-4">
          <p className="text-sm text-muted">Turning this off blocks new anonymous bakes. Existing images and runtime bindings remain available.</p>
          <Switch
            aria-label="Allow anonymous image bakes"
            checked={org.data?.allowAnonymousImageBakes ?? false}
            disabled={!org.data || org.data.callerRole !== "admin" || patch.isPending}
            onCheckedChange={(enabled) => patch.mutate({ allowAnonymousImageBakes: enabled })}
          />
        </div>
        {patch.error && <p className="text-sm text-danger-500">{patch.error.message}</p>}
      </Section>
      <SourcesSection />
    </div>
  );
}
