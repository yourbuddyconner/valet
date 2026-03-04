import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCreateAPIKey, type APIKeyWithToken } from '@/api/api-keys';

interface CreateAPIKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateAPIKeyDialog({ open, onOpenChange }: CreateAPIKeyDialogProps) {
  const [name, setName] = React.useState('');
  const [createdKey, setCreatedKey] = React.useState<APIKeyWithToken | null>(null);
  const [copied, setCopied] = React.useState(false);
  const createKey = useCreateAPIKey();

  const handleCreate = () => {
    if (!name.trim()) return;

    createKey.mutate(
      { name: name.trim() },
      {
        onSuccess: (key) => {
          setCreatedKey(key);
        },
      }
    );
  };

  const handleCopy = async () => {
    if (createdKey?.token) {
      await navigator.clipboard.writeText(createdKey.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleClose = (newOpen: boolean) => {
    if (!newOpen) {
      // Reset state when closing
      setName('');
      setCreatedKey(null);
      setCopied(false);
      createKey.reset();
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        {createdKey ? (
          <>
            <DialogHeader>
              <DialogTitle>API Key Created</DialogTitle>
              <DialogDescription>
                Copy your API key now. You won't be able to see it again.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-4 space-y-4">
              <div>
                <label className="text-sm font-medium text-neutral-700">
                  API Key
                </label>
                <div className="mt-1 flex gap-2">
                  <Input
                    value={createdKey.token}
                    readOnly
                    className="font-mono text-sm"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleCopy}
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </Button>
                </div>
              </div>

              <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
                Store this key securely. For security reasons, we cannot show it again.
              </div>
            </div>

            <DialogFooter className="mt-6">
              <Button onClick={() => handleClose(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create API Key</DialogTitle>
              <DialogDescription>
                Create a new API key to authenticate with the Valet API.
              </DialogDescription>
            </DialogHeader>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleCreate();
              }}
              className="mt-4 space-y-4"
            >
              <div>
                <label htmlFor="keyName" className="text-sm font-medium text-neutral-700">
                  Key Name
                </label>
                <Input
                  id="keyName"
                  placeholder="e.g., Development, CI/CD"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1"
                  autoFocus
                />
              </div>

              {createKey.isError && (
                <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">
                  Failed to create API key. Please try again.
                </div>
              )}

              <DialogFooter>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => handleClose(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!name.trim() || createKey.isPending}
                >
                  {createKey.isPending ? 'Creating...' : 'Create Key'}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
