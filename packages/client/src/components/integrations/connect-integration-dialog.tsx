import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api } from '@/api/client';
import { useAvailableIntegrations, useIntegrations, useConfigureIntegration, type AvailableService } from '@/api/integrations';
import { useSetUserCredential } from '@/api/auth';
import { useSetupTelegram } from '@/api/orchestrator';
import {
  OnePasswordIcon, TelegramIcon, GitHubIcon, GmailIcon, CalendarIcon,
  NotionIcon, LinearIcon, DiscordIcon, SlackIcon, TypefullyIcon,
  DefaultServiceIcon,
} from './service-icons';

// ─── Client-side metadata for display (icons, descriptions, token config) ────

interface ServiceMeta {
  icon: React.FC<{ className?: string }>;
  description: string;
  /** Override connection type for non-OAuth services (1Password, Telegram). */
  connectionType?: 'token';
  tokenLabel?: string;
  tokenPlaceholder?: string;
  tokenHelpText?: React.ReactNode;
  /** For token-based: credential provider ID (for user credentials API) */
  credentialProvider?: string;
}

const SERVICE_META: Record<string, ServiceMeta> = {
  '1password': {
    icon: OnePasswordIcon,
    description: 'Secret management for agent sessions',
    connectionType: 'token',
    tokenLabel: 'Service Account Token',
    tokenPlaceholder: 'ops_...',
    credentialProvider: '1password',
  },
  telegram: {
    icon: TelegramIcon,
    description: 'Bot messaging for your orchestrator',
    connectionType: 'token',
    tokenLabel: 'Bot Token',
    tokenPlaceholder: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
    tokenHelpText: (
      <>
        Create a bot via{' '}
        <a
          href="https://t.me/BotFather"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          @BotFather
        </a>{' '}
        on Telegram.
      </>
    ),
  },
  github: {
    icon: GitHubIcon,
    description: 'Repositories, issues, and pull requests',
  },
  gmail: {
    icon: GmailIcon,
    description: 'Email messages and labels',
  },
  google_calendar: {
    icon: CalendarIcon,
    description: 'Events and calendars',
  },
  notion: {
    icon: NotionIcon,
    description: 'Pages and databases',
  },
  linear: {
    icon: LinearIcon,
    description: 'Issues, projects, and teams',
  },
  typefully: {
    icon: TypefullyIcon,
    description: 'Social media content scheduling and publishing',
    connectionType: 'token',
    tokenLabel: 'API Key',
    tokenPlaceholder: 'tf_...',
    tokenHelpText: (
      <>
        Get your API key from{' '}
        <a
          href="https://typefully.com/settings/api"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          Typefully Settings
        </a>
        .
      </>
    ),
  },
  discord: {
    icon: DiscordIcon,
    description: 'Channels and messages',
  },
  slack: {
    icon: SlackIcon,
    description: 'Team messaging and channels',
  },
};

const DEFAULT_META: ServiceMeta = {
  icon: DefaultServiceIcon,
  description: '',
};

// ─── Resolved service type (API data + client metadata) ────────────────────

interface ResolvedService {
  id: string;
  name: string;
  description: string;
  icon: React.FC<{ className?: string }>;
  connectionType: 'oauth' | 'token';
  tokenLabel?: string;
  tokenPlaceholder?: string;
  tokenHelpText?: React.ReactNode;
  credentialProvider?: string;
  /** True when this service comes from the integration registry (has an IntegrationPackage). */
  fromRegistry?: boolean;
  /** Entities to configure when creating the integration (from registry). */
  supportedEntities?: string[];
}

function resolveService(svc: AvailableService): ResolvedService {
  const meta = SERVICE_META[svc.service] ?? DEFAULT_META;
  return {
    id: svc.service,
    name: svc.displayName,
    description: meta.description || svc.supportedEntities.join(', '),
    icon: meta.icon,
    connectionType: meta.connectionType ?? 'oauth',
    tokenLabel: meta.tokenLabel,
    tokenPlaceholder: meta.tokenPlaceholder,
    tokenHelpText: meta.tokenHelpText,
    credentialProvider: meta.credentialProvider,
    fromRegistry: true,
    supportedEntities: svc.supportedEntities,
  };
}

// ─── Token-based services (not from the integration registry) ──────────────
// 1Password and Telegram use different APIs and aren't registered as
// IntegrationPackages. Built as ResolvedService entries and filtered by
// admin-disabled state at render time.

const TOKEN_SERVICE_IDS = ['1password', 'telegram'] as const;
const TOKEN_SERVICE_NAMES: Record<string, string> = { '1password': '1Password', telegram: 'Telegram' };

function buildTokenServices(disabledServices: Set<string>): ResolvedService[] {
  return TOKEN_SERVICE_IDS
    .filter((id) => SERVICE_META[id] && !disabledServices.has(id))
    .map((id) => {
      const meta = SERVICE_META[id]!;
      return {
        id,
        name: TOKEN_SERVICE_NAMES[id] ?? id,
        description: meta.description,
        icon: meta.icon,
        connectionType: 'token' as const,
        tokenLabel: meta.tokenLabel,
        tokenPlaceholder: meta.tokenPlaceholder,
        tokenHelpText: meta.tokenHelpText,
        credentialProvider: meta.credentialProvider,
      };
    });
}

// Services that are pre-configured at the org level and should not appear
// in the user-facing "Connect Integration" dialog.
const PRE_CONFIGURED_SERVICES = new Set(['deepwiki', 'github', 'slack']);

// ─── Component ─────────────────────────────────────────────────────────────

interface ConnectIntegrationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConnectIntegrationDialog({
  open,
  onOpenChange,
}: ConnectIntegrationDialogProps) {
  const [selectedService, setSelectedService] = React.useState<ResolvedService | null>(null);
  const [connecting, setConnecting] = React.useState<string | null>(null);
  const { data, isLoading } = useAvailableIntegrations();
  const { data: existingData } = useIntegrations();

  // Merge token-based services + API-sourced OAuth services, filtering out
  // admin-disabled, pre-configured, and already-connected services.
  const services = React.useMemo(() => {
    const disabled = new Set(data?.disabledServices ?? []);
    const connected = new Set<string>(
      (existingData?.integrations ?? [])
        .filter((i) => i.status === 'active' || i.status === 'pending')
        .map((i) => i.service),
    );
    const tokenServices = buildTokenServices(disabled)
      .filter((svc) => !connected.has(svc.id));
    const oauthServices = (data?.services ?? [])
      .filter((svc) => !PRE_CONFIGURED_SERVICES.has(svc.service) && !connected.has(svc.service))
      .map(resolveService);
    return [...tokenServices, ...oauthServices];
  }, [data, existingData]);

  function handleClose(isOpen: boolean) {
    if (!isOpen) {
      setSelectedService(null);
      setConnecting(null);
    }
    onOpenChange(isOpen);
  }

  const handleSelectService = async (service: ResolvedService) => {
    if (service.connectionType === 'token') {
      setSelectedService(service);
      return;
    }

    // OAuth flow
    setConnecting(service.id);
    try {
      const redirectUri = `${window.location.origin}/integrations/callback`;
      const response = await api.get<{ url: string; state: string; code_verifier?: string }>(
        `/integrations/${service.id}/oauth?redirect_uri=${encodeURIComponent(redirectUri)}`
      );
      sessionStorage.setItem('oauth_state', response.state);
      sessionStorage.setItem('oauth_service', service.id);
      if (response.code_verifier) {
        sessionStorage.setItem('oauth_code_verifier', response.code_verifier);
      }
      window.location.href = response.url;
    } catch (error) {
      console.error('Failed to initiate OAuth:', error);
      setConnecting(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        {selectedService ? (
          <TokenSetupStep
            service={selectedService}
            onBack={() => setSelectedService(null)}
            onComplete={() => handleClose(false)}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Connect Integration</DialogTitle>
              <DialogDescription>
                Choose a service to connect with your Valet workspace.
              </DialogDescription>
            </DialogHeader>

            {isLoading ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-[76px] animate-pulse rounded-lg border border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800"
                  />
                ))}
              </div>
            ) : (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {services.map((service) => (
                  <button
                    key={service.id}
                    onClick={() => handleSelectService(service)}
                    disabled={connecting === service.id}
                    className="flex items-start gap-3 rounded-lg border border-neutral-200 bg-white p-4 text-left transition-colors hover:bg-neutral-50 disabled:cursor-wait disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800 dark:hover:bg-neutral-750"
                  >
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-700">
                      <service.icon className="h-5 w-5" />
                    </div>
                    <div className="flex-1">
                      <p className="font-medium text-neutral-900 dark:text-neutral-100">{service.name}</p>
                      <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
                        {service.description}
                      </p>
                    </div>
                    {connecting === service.id && (
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Token Setup Step ───────────────────────────────────────────────────

function TokenSetupStep({
  service,
  onBack,
  onComplete,
}: {
  service: ResolvedService;
  onBack: () => void;
  onComplete: () => void;
}) {
  const [token, setToken] = React.useState('');
  const setCredential = useSetUserCredential();
  const setupTelegram = useSetupTelegram();
  const configureIntegration = useConfigureIntegration();

  const isPending = setCredential.isPending || setupTelegram.isPending || configureIntegration.isPending;
  const error = setCredential.isError
    ? 'Failed to save credential'
    : setupTelegram.isError
      ? ((setupTelegram.error as any)?.message?.includes('400')
        ? 'Invalid bot token'
        : 'Failed to connect')
      : configureIntegration.isError
        ? 'Failed to connect integration'
        : null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;

    if (service.fromRegistry) {
      // Integration-registry services (e.g. Typefully) — create via integrations API
      configureIntegration.mutate(
        {
          service: service.id as any,
          credentials: { access_token: token.trim() },
          config: { entities: service.supportedEntities ?? [] },
        },
        { onSuccess: onComplete },
      );
    } else if (service.id === 'telegram') {
      setupTelegram.mutate(
        { botToken: token.trim() },
        { onSuccess: onComplete },
      );
    } else if (service.credentialProvider) {
      setCredential.mutate(
        { provider: service.credentialProvider, key: token.trim() },
        { onSuccess: onComplete },
      );
    }
  }

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-700">
            <service.icon className="h-5 w-5" />
          </div>
          <div>
            <DialogTitle>Connect {service.name}</DialogTitle>
            <DialogDescription>{service.description}</DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <div>
          <label
            htmlFor="integration-token"
            className="block text-sm font-medium text-neutral-700 dark:text-neutral-300"
          >
            {service.tokenLabel ?? 'Token'}
          </label>
          <input
            id="integration-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={service.tokenPlaceholder}
            autoComplete="off"
            autoFocus
            className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-400 dark:focus:ring-neutral-400"
          />
          {service.tokenHelpText && (
            <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
              {service.tokenHelpText}
            </p>
          )}
        </div>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onBack}
            className="text-sm text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
          >
            &larr; Back
          </button>
          <Button type="submit" disabled={!token.trim() || isPending}>
            {isPending ? 'Connecting...' : 'Connect'}
          </Button>
        </div>
      </form>
    </>
  );
}

// Icons are imported from ./service-icons.tsx
