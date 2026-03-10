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
import { useAvailableIntegrations, useConfigureIntegration, type AvailableService } from '@/api/integrations';
import { useSetUserCredential } from '@/api/auth';
import { useSetupTelegram } from '@/api/orchestrator';

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
// IntegrationPackages. They're always shown if their meta is defined.

const TOKEN_SERVICES: ResolvedService[] = (['1password', 'telegram'] as const)
  .filter((id) => SERVICE_META[id])
  .map((id) => {
    const meta = SERVICE_META[id]!;
    return {
      id,
      name: id === '1password' ? '1Password' : 'Telegram',
      description: meta.description,
      icon: meta.icon,
      connectionType: 'token' as const,
      tokenLabel: meta.tokenLabel,
      tokenPlaceholder: meta.tokenPlaceholder,
      tokenHelpText: meta.tokenHelpText,
      credentialProvider: meta.credentialProvider,
    };
  });

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

  // Merge token-based services + API-sourced OAuth services
  const services = React.useMemo(() => {
    const oauthServices = (data?.services ?? []).map(resolveService);
    return [...TOKEN_SERVICES, ...oauthServices];
  }, [data]);

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

// ─── Icons ──────────────────────────────────────────────────────────────

function OnePasswordIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .007C5.373.007 0 5.376 0 11.999c0 6.624 5.373 11.994 12 11.994S24 18.623 24 12C24 5.376 18.627.007 12 .007Zm-.895 4.857h1.788c.484 0 .729.002.914.096a.86.86 0 0 1 .377.377c.094.185.095.428.095.912v6.016c0 .12 0 .182-.015.238a.427.427 0 0 1-.067.137.923.923 0 0 1-.174.162l-.695.564c-.113.092-.17.138-.191.194a.216.216 0 0 0 0 .15c.02.055.078.101.191.193l.695.565c.094.076.14.115.174.162.03.042.053.087.067.137a.936.936 0 0 1 .015.238v2.746c0 .484-.001.727-.095.912a.86.86 0 0 1-.377.377c-.185.094-.43.096-.914.096h-1.788c-.484 0-.726-.002-.912-.096a.86.86 0 0 1-.377-.377c-.094-.185-.095-.428-.095-.912v-6.016c0-.12 0-.182.015-.238a.437.437 0 0 1 .067-.139c.034-.047.08-.083.174-.16l.695-.564c.113-.092.17-.138.191-.194a.216.216 0 0 0 0-.15c-.02-.055-.078-.101-.191-.193l-.695-.565a.92.92 0 0 1-.174-.162.437.437 0 0 1-.067-.139.92.92 0 0 1-.015-.236V6.25c0-.484.001-.727.095-.912a.86.86 0 0 1 .377-.377c.186-.094.428-.096.912-.096z" />
    </svg>
  );
}

function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function GmailIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 010 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z" />
    </svg>
  );
}

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function NotionIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 2.02c-.42-.326-.98-.7-2.055-.607L3.01 2.72c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952l1.448.327s0 .84-1.168.84l-3.22.186c-.094-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.453-.233 4.763 7.279v-6.44l-1.215-.14c-.093-.514.28-.887.747-.933zM2.877 1.106l13.542-1.027c1.635-.14 2.055-.047 3.08.7l4.204 2.962c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.13-4.016c-.56-.747-.793-1.306-.793-1.96V2.92c0-.84.373-1.68 1.262-1.773z" />
    </svg>
  );
}

function LinearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M2.643 13.673a10.202 10.202 0 0 0 7.685 7.684L2.643 13.673Zm-.46-1.725a10.18 10.18 0 0 0 1.048 4.518L10.466 3.23a10.18 10.18 0 0 0-4.518-1.048l-3.765 9.766Zm5.082-9.476L3.547 9.189A10.235 10.235 0 0 1 7.265 2.472Zm2.252-.834 11.888 11.888a10.218 10.218 0 0 0-1.085-8.86L13.377 1.697a10.218 10.218 0 0 0-3.86-.059Zm5.705 1.263 4.596 4.596a10.26 10.26 0 0 0-1.378-3.088l-1.53-1.53a10.177 10.177 0 0 0-1.688-.978Zm3.318 6.132-8.573-8.573a10.238 10.238 0 0 1 6.262 2.311l2.311 2.311a10.22 10.22 0 0 1 0 3.95Zm1.268 2.598L12.13 3.953a10.216 10.216 0 0 1 3.994 1.216l6.85 6.85a10.28 10.28 0 0 1-1.166 3.614Zm.096 2.145-9.908-9.908a10.22 10.22 0 0 1 2.728.91l8.24 8.24a10.324 10.324 0 0 1-1.06.758Z" />
    </svg>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

function SlackIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
    </svg>
  );
}

function TypefullyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 5h18a1 1 0 0 1 0 2H3a1 1 0 0 1 0-2zm0 6h12a1 1 0 0 1 0 2H3a1 1 0 0 1 0-2zm0 6h8a1 1 0 0 1 0 2H3a1 1 0 0 1 0-2z" />
    </svg>
  );
}

function DefaultServiceIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </svg>
  );
}
