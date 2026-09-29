import type { EventDeliveryPolicy } from "@valet/api/wire";

export type DeliveryPreferencesValue = { deliveryPolicy: EventDeliveryPolicy; pauseOnOverlap: boolean };

/** Shared by personal subscription creation and editing. */
export function DeliveryPreferences({ value, onChange }: {
  value: DeliveryPreferencesValue;
  onChange: (value: DeliveryPreferencesValue) => void;
}) {
  return <fieldset className="grid gap-2 rounded-lg border border-line p-3">
    <legend className="px-1 text-sm font-medium">When a team also receives this event</legend>
    <select aria-label="Team delivery preference" className="w-full rounded border border-line bg-paper px-3 py-2 text-sm"
      value={value.deliveryPolicy} onChange={(event) => {
        const deliveryPolicy = event.target.value;
        if (deliveryPolicy === "always" || deliveryPolicy === "ignoreIfMyTeamSubscribed" || deliveryPolicy === "ignoreIfAnyTeamSubscribed") onChange({ ...value, deliveryPolicy });
      }}>
      <option value="always">Deliver to my personal agent too</option>
      <option value="ignoreIfMyTeamSubscribed">Skip if one of my teams matches</option>
      <option value="ignoreIfAnyTeamSubscribed">Skip if any team in my organization matches</option>
    </select>
    {value.deliveryPolicy !== "always" && <>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={value.pauseOnOverlap}
        onChange={(event) => onChange({ ...value, pauseOnOverlap: event.target.checked })} />Pause this subscription when an overlap occurs</label>
      <p className="text-xs leading-5 text-muted">{value.pauseOnOverlap
        ? "All deliveries from this subscription will stop until you turn it back on. To receive overlapping events after re-enabling, choose ‘Deliver to my personal agent too’."
        : "Only matching events are skipped. Other events continue to arrive."} Disabled team subscriptions do not count. Event Logs explain each skipped delivery.</p>
    </>}
  </fieldset>;
}
