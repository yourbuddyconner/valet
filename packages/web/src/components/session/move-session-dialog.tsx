import { useState } from "react";
import type { AssistantOwner } from "@valet/api/wire";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  SelectMenu,
} from "~/components/primitives";
import { useMoveSession } from "~/api/queries";
import { useOrg, useTeams } from "~/api/settings";
import { eligibleTeams } from "~/components/session/assistant-rail";
import { errorText } from "~/lib/error-text";
import { PERSONAL } from "~/lib/workspace-scope";

/**
 * "Move to workspace…" — reassigns a standalone session between the
 * caller's own workspace and their teams (`PATCH /:id` with `teamId`).
 *
 * This is also the migration path: before the workspace-aware create
 * landed, the web UI could only make personal sessions, so every existing
 * session sits in Personal regardless of whose work it holds.
 *
 * Assistant sessions never get this dialog — an assistant's session is
 * addressed by its owner (`assistant:{id}`), so its owner is structural,
 * not a property to edit.
 */
export function MoveSessionDialog({
  sessionId,
  owner,
  open,
  onOpenChange,
}: {
  sessionId: string;
  /** The session's current owner, so the picker starts where the row is. */
  owner: AssistantOwner;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const teamsQ = useTeams();
  const orgQ = useOrg();
  const move = useMoveSession(sessionId);

  const teams = eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations);
  const currentKey = owner.type === "team" ? owner.id : PERSONAL;
  const [selected, setSelected] = useState(currentKey);

  const options = [
    { value: PERSONAL, label: "Personal" },
    ...teams.map((t) => ({ value: t.id, label: t.name })),
  ];
  const selectedTeam = teams.find((t) => t.id === selected);
  const unchanged = selected === currentKey;

  function submit() {
    if (unchanged) {
      onOpenChange(false);
      return;
    }
    move.mutate(selected === PERSONAL ? null : selected, {
      onSuccess: () => onOpenChange(false),
    });
  }

  // No reset machinery: the header mounts this dialog only while it is
  // open (`{moving && …}`), so every open is a fresh mount and `selected`
  // initializes from the row's real owner above. A close-time or open-time
  // reset would be dead code — and dead resets read as load-bearing.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Move to workspace"
        description="The runtime keeps its threads, history, and sandbox. Who can open it changes."
      >
        <SelectMenu
          value={selected}
          onChange={setSelected}
          triggerLabel={options.find((o) => o.value === selected)?.label ?? "Pick a workspace"}
          options={options}
        />
        <p className="text-xs text-muted">
          {selectedTeam
            ? `Everyone on ${selectedTeam.name} can read its threads and send messages. Team admins can manage it.`
            : "Only you can open it."}
        </p>
        {move.error != null && <p className="text-xs text-danger-500">{errorText(move.error)}</p>}
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={move.isPending}
          >
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={unchanged || move.isPending}>
            {move.isPending ? "Moving…" : "Move runtime"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
