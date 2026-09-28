import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { NotificationKind } from "@valet/api/wire";
import { useNotificationPreferences, useSetNotificationPreference } from "~/api/queries";
import { Section } from "~/components/settings/section";
import { FieldRow } from "~/components/settings/field-row";
import { Spinner, Switch } from "~/components/primitives";
import { Sparkles } from "lucide-react";
import { isAttentionSoundEnabled, setAttentionSoundEnabled } from "~/lib/use-attention-ping";
import {
  isNaviModeEnabled,
  playAttentionChime,
  setNaviModeEnabled,
} from "~/lib/notification-sound";

/** Personal web delivery and optional team direct-message copies, by notification kind. */
export const Route = createFileRoute("/settings/notifications")({
  component: NotificationsPage,
});

const NOTIFICATION_KINDS: NotificationKind[] = [
  "notification",
  "question",
  "escalation",
  "approval",
  "review",
];

const KIND_LABEL: Record<NotificationKind, string> = {
  notification: "Notifications",
  question: "Questions",
  escalation: "Escalations",
  approval: "Approvals",
  review: "Team deletion requests",
};

const KIND_DESCRIPTION: Record<NotificationKind, string> = {
  notification: "General updates from your assistant.",
  question: "When your assistant needs an answer to keep going.",
  escalation: "When something needs your attention urgently.",
  approval: "When a decision gate is waiting on you.",
  review: "When a team resource needs your review before deletion.",
};

export function NotificationsPage() {
  const prefsQ = useNotificationPreferences();
  const setPref = useSetNotificationPreference();
  // Device-local on purpose. Whether a machine may make noise depends on
  // where it is — a desk, a meeting room, a laptop in a cafe — not on who
  // is signed in, so this does not belong on the account.
  const [sound, setSound] = useState(() => isAttentionSoundEnabled());
  // Deliberately unexplained. See the sparkle button below.
  const [navi, setNavi] = useState(() => isNaviModeEnabled());

  const byKind = new Map(prefsQ.data?.preferences.map((p) => [p.kind, p]));

  return (
    <Section title="Notifications" description="Choose which updates reach you here.">
      <FieldRow
        label="Sound"
        hint="Play a short chime when your assistant is blocked and waiting on you. Updates stay silent. This device only."
      >
        <div className="flex items-center gap-3">
          <Switch
            checked={sound}
            onCheckedChange={(next) => {
              setAttentionSoundEnabled(next);
              setSound(next);
              // Play it on the way ON so the choice is audible, and because
              // the click doubles as the gesture that unblocks audio.
              if (next) playAttentionChime();
            }}
            aria-label="Attention sound"
          />
          {/* An easter egg, and it stays one: no label, no tooltip, no hint
              text. Faint until hovered; softly lit while active is the only
              clue anything changed. It swaps WHICH sound plays — the toggle
              above still decides IF one plays. */}
          <button
            type="button"
            aria-label="hey, listen"
            onClick={() => {
              const next = !navi;
              setNaviModeEnabled(next);
              setNavi(next);
              // Play whichever sound is now active so the change is audible
              // either way, using the click as the audio-unblock gesture.
              playAttentionChime();
            }}
            className={
              navi
                ? "text-accent-500 drop-shadow-[0_0_6px_currentColor] transition-opacity"
                : "text-muted opacity-25 transition-opacity hover:opacity-70"
            }
          >
            <Sparkles size={14} />
          </button>
        </div>
      </FieldRow>

      <p className="py-3 text-sm text-muted">Team DM copies are off by default. Enable copies for teams you can access using your linked messaging account. Approval permissions stay unchanged.</p>
      {setPref.error && <div role="alert" className="text-sm text-danger-500">Could not save your preference. Try again.</div>}
      {prefsQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {prefsQ.error && (
        <div className="py-4 text-sm text-danger-500">
          Failed to load notification preferences.
        </div>
      )}
      {!prefsQ.isLoading &&
        !prefsQ.error &&
        NOTIFICATION_KINDS.map((kind) => {
          // Web delivery defaults to on until the caller has an explicit
          // row — mirrors the API's own default (see notifications.ts).
          const web = byKind.get(kind)?.web ?? true;
          return (
            <FieldRow key={kind} label={KIND_LABEL[kind]} hint={KIND_DESCRIPTION[kind]}>
              <div className="flex items-center gap-4"><label className="flex items-center gap-2 text-sm">Web<Switch
                disabled={setPref.isPending}
                checked={web}
                onCheckedChange={(next) => setPref.mutate({ kind, web: next })}
                aria-label={`${KIND_LABEL[kind]} web notifications`}
              /></label>{kind !== "review" && <label className="flex items-center gap-2 text-sm">Team DM copies<Switch checked={byKind.get(kind)?.teamDm ?? false} disabled={setPref.isPending} onCheckedChange={(teamDm) => setPref.mutate({ kind, web, teamDm })} aria-label={`${KIND_LABEL[kind]} team DM copies`} /></label>}</div>
            </FieldRow>
          );
        })}
    </Section>
  );
}
