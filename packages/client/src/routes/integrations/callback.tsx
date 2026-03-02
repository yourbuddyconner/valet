import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { api } from '@/api/client';
import { useConfigureIntegration } from '@/api/integrations';

export const Route = createFileRoute('/integrations/callback')({
  component: OAuthCallbackPage,
});

function OAuthCallbackPage() {
  const navigate = useNavigate();
  const configureIntegration = useConfigureIntegration();
  const [status, setStatus] = React.useState<'processing' | 'success' | 'error'>('processing');
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const hasProcessed = React.useRef(false);

  React.useEffect(() => {
    if (hasProcessed.current) return;
    hasProcessed.current = true;

    handleCallback();
  }, []);

  const handleCallback = async () => {
    try {
      const url = new URL(window.location.href);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        setStatus('error');
        setErrorMessage(url.searchParams.get('error_description') || 'Authorization was denied');
        return;
      }

      if (!code) {
        setStatus('error');
        setErrorMessage('No authorization code received');
        return;
      }

      // Verify state matches what we stored
      const storedState = sessionStorage.getItem('oauth_state');
      const storedService = sessionStorage.getItem('oauth_service');

      if (!storedService) {
        setStatus('error');
        setErrorMessage('OAuth session expired. Please try again.');
        return;
      }

      if (state && storedState && state !== storedState) {
        setStatus('error');
        setErrorMessage('Security validation failed. Please try again.');
        return;
      }

      // Exchange code for credentials
      const redirectUri = `${window.location.origin}/integrations/callback`;
      const credentialsResponse = await api.post<{ credentials: Record<string, string> }>(
        `/integrations/${storedService}/oauth/callback`,
        { code, redirect_uri: redirectUri }
      );

      // Configure the integration with the obtained credentials
      await configureIntegration.mutateAsync({
        service: storedService as any,
        credentials: credentialsResponse.credentials,
        config: {
          entities: [],
        },
      });

      // Clean up session storage
      sessionStorage.removeItem('oauth_state');
      sessionStorage.removeItem('oauth_service');

      setStatus('success');

      // Redirect to integrations page after a short delay
      setTimeout(() => {
        navigate({ to: '/integrations' });
      }, 2000);
    } catch (error) {
      console.error('OAuth callback error:', error);
      setStatus('error');
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to complete authorization'
      );
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-neutral-50 p-4">
      <div className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-8 text-center">
        {status === 'processing' && (
          <>
            <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-neutral-200 border-t-neutral-900" />
            <h1 className="mt-4 text-lg font-semibold text-neutral-900">
              Connecting...
            </h1>
            <p className="mt-2 text-sm text-neutral-500">
              Please wait while we complete the authorization.
            </p>
          </>
        )}

        {status === 'success' && (
          <>
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
              <svg
                className="h-6 w-6 text-green-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <h1 className="mt-4 text-lg font-semibold text-neutral-900">
              Connected!
            </h1>
            <p className="mt-2 text-sm text-neutral-500">
              Your integration has been set up successfully.
            </p>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
              <svg
                className="h-6 w-6 text-red-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </div>
            <h1 className="mt-4 text-lg font-semibold text-neutral-900">
              Connection Failed
            </h1>
            <p className="mt-2 text-sm text-neutral-500">{errorMessage}</p>
            <button
              onClick={() => navigate({ to: '/integrations' })}
              className="mt-4 inline-flex items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
            >
              Back to Integrations
            </button>
          </>
        )}
      </div>
    </div>
  );
}
