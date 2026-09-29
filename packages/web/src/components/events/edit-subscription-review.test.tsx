// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventSubscriptionWire } from "@valet/api/wire";
import { EditSubscriptionDialog } from "./edit-subscription-dialog";
const patch = vi.fn();
vi.mock("~/api/events", () => ({
  useEventCatalog: () => ({ data: { services: [] } }),
  usePatchEventSubscription: () => ({ mutate: patch, isPending: false }),
}));
vi.mock("./automation-wizard", () => ({ EventMatchStep: () => <div>Event match</div>, unionFilterFields: () => [] }));
const sub: EventSubscriptionWire = {
  id: "proposal-1", name: "Follow launch", ownerType: "user", ownerId: "u1",
  eventKeys: ["slack.message"], filters: [{ field: "channel", op: "eq", value: "C123" }, { field: "thread_ts", op: "eq", value: "1790650000.123456" }],
  target: { kind: "orchestrator", orchestrator: "user", follow: true }, enabled: false,
  createdBy: "u1", createdAt: 1, updatedAt: 1,
};
beforeEach(() => patch.mockReset());
describe("saved automation review", () => {
  it("does not activate on open and patches the same proposal once confirmed", () => {
    render(<EditSubscriptionDialog open review sub={sub} targetLabel="Personal assistant" onOpenChange={() => {}} />);
    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByText("Scope")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Follow release" } });
    fireEvent.click(screen.getByRole("button", { name: "Enable subscription" }));
    expect(patch.mock.calls[0][0]).toMatchObject({ id: "proposal-1", body: { name: "Follow release", enabled: true } });
  });
  it("cancel leaves the proposal disabled", () => {
    const close = vi.fn();
    render(<EditSubscriptionDialog open review sub={sub} targetLabel="Personal assistant" onOpenChange={close} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(close).toHaveBeenCalledWith(false);
    expect(patch).not.toHaveBeenCalled();
  });
});
