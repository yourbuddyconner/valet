/**
 * Live-cluster smoke test for `KubernetesImageBuilder` (sandbox images v2
 * plan, Task 5) against the vendored bundled registry on rancher-desktop.
 *
 * Context safety (decision 2, BINDING): every kubectl invocation pins
 * `--context rancher-desktop` explicitly, and the client-node calls go
 * through `@valet/sandbox-kubernetes`'s `loadRancherDesktopKubeConfig`
 * (test-only, scoped to live-cluster test suites — see its docblock;
 * `providers/sandbox-backend.ts`'s production `resolveKubeConfig` must
 * NEVER be swapped for this, but a *test* pinning the known-safe local
 * context is exactly what it's for). Nothing here ever touches the
 * ambient current-context (a production GKE cluster on this machine).
 *
 * NOTE: at the time this test was written, the bundled registry chart
 * pieces (`deploy/chart/valet/templates/registry-*.yaml`) exist but have
 * not yet been `helm upgrade`d onto the rancher-desktop cluster — that's
 * T7's dogfood pass. Per the task brief: "skip-unless-registry-present" —
 * this suite does NOT deploy the registry itself; it probes for the
 * `valet-registry` Service in `valet-sandboxes` and skips entirely when
 * absent, so it starts exercising the full build→push→status loop for
 * free the moment a future `helm upgrade` lands the registry, with no
 * further changes needed here.
 */
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as k8s from "@kubernetes/client-node";
import { RANCHER_DESKTOP_CONTEXT, batchJobsApiAdapter, loadRancherDesktopKubeConfig } from "@valet/sandbox-kubernetes";
import { KubernetesImageBuilder } from "./k8s-builder.js";
import type { PrebuildSpec } from "./builder.js";

const NAMESPACE = "valet-sandboxes";

function kubectl(args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync("kubectl", ["--context", RANCHER_DESKTOP_CONTEXT, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "" };
}

function registryPresent(): boolean {
  const ctx = kubectl(["config", "get-contexts", RANCHER_DESKTOP_CONTEXT]);
  if (ctx.status !== 0) return false;
  const svc = kubectl(["-n", NAMESPACE, "get", "service", "valet-registry"]);
  return svc.status === 0;
}

// Also skip in CI: this needs a live rancher-desktop k8s cluster + kubectl
// context, which the GitHub runner does not have (`CI` = GitHub Actions).
describe.skipIf(!registryPresent() || !!process.env.CI)("KubernetesImageBuilder (live rancher-desktop, bundled registry)", () => {
  let builder: KubernetesImageBuilder;
  let buildId: string | undefined;

  beforeAll(() => {
    const kc = loadRancherDesktopKubeConfig(k8s.KubeConfig);
    const jobsApi = batchJobsApiAdapter(kc.makeApiClient(k8s.BatchV1Api), kc.makeApiClient(k8s.CoreV1Api));
    builder = new KubernetesImageBuilder({
      jobsApi,
      namespace: NAMESPACE,
      registryInsecure: true,
    });
  });

  afterAll(async () => {
    if (buildId) await builder.cancel(buildId).catch(() => {});
  });

  it(
    "builds a trivial public-repo spec end-to-end and reaches a terminal state",
    async () => {
      const spec: PrebuildSpec = {
        configId: "cluster-smoke",
        prebuildId: `pb-cluster-smoke-${Date.now()}`,
        cloneUrl: "https://github.com/octocat/Hello-World.git",
        commitSha: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11",
        baseImage: "alpine/git:2.47.2",
        recipe: [],
        imageRef: "valet-registry:5000/octocat-hello-world:cluster-smoke",
      };
      const dispatched = await builder.build(spec);
      buildId = dispatched.buildId;

      let status = await builder.status(buildId);
      // Generous budget: a cold run pulls the buildkit image AND the base
      // image before the first build step, which can dominate wall-clock on
      // a busy node. Live-infra tests get slack, not tight deadlines.
      const deadline = Date.now() + 420_000;
      while ((status.state === "queued" || status.state === "building") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        status = await builder.status(buildId);
      }

      expect(status.state, JSON.stringify(status)).toBe("pushed");
      // Successful completion runs secret/configmap cleanup. A second
      // status() call must still resolve
      // without throwing (the Job itself is left standing until cancel()).
      await expect(builder.status(buildId)).resolves.toBeDefined();
    },
    480_000,
  );
});
