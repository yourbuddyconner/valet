import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toastSuccess } from '@/hooks/use-toast';

interface WebhookTokenRevealProps {
  /**
   * When set, the dialog is open and the token + URL are shown.
   * Pass `null` to hide the dialog. Token is never re-issued — the
   * server only returns it on the create/transition response, so once
   * this dialog closes the value is irrecoverable.
   */
  token: string | null;
  webhookUrl?: string;
  onClose: () => void;
}

export function WebhookTokenReveal({ token, webhookUrl, onClose }: WebhookTokenRevealProps) {
  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toastSuccess('Copied', `${label} copied to clipboard.`);
    } catch {
      // Clipboard API can fail on insecure origins / sandboxed iframes —
      // fall back to selecting the text via a hidden input would just be
      // noise. Surface a soft error and let the user copy manually.
      toastSuccess('Copy unavailable', `Select and copy the ${label.toLowerCase()} manually.`);
    }
  };

  const open = token !== null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Webhook token</DialogTitle>
          <DialogDescription>
            Copy this token now — it is shown <strong>only once</strong>. The server cannot reveal it again.
            Save it somewhere secure and pass it as the <code>X-Valet-Trigger-Token</code> request header.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-3">
          {token && (
            <Field
              label="Token"
              value={token}
              onCopy={() => copy(token, 'Token')}
              mono
            />
          )}
          {webhookUrl && (
            <Field
              label="Webhook URL"
              value={webhookUrl}
              onCopy={() => copy(webhookUrl, 'Webhook URL')}
            />
          )}
        </div>

        <DialogFooter>
          <Button type="button" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value, onCopy, mono, hint }: { label: string; value: string; onCopy: () => void; mono?: boolean; hint?: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{label}</label>
        <Button type="button" size="sm" variant="secondary" onClick={onCopy}>
          Copy
        </Button>
      </div>
      <div className={
        `break-all rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-900 ${mono ? 'font-mono' : ''}`
      }>
        {value}
      </div>
      {hint && (
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>
      )}
    </div>
  );
}
