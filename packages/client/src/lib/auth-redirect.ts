interface BuildAuthRedirectUrlArgs {
  workerUrl: string;
  providerId: string;
  origin: string;
  inviteCode?: string;
}

export function buildAuthRedirectUrl(args: BuildAuthRedirectUrlArgs): string {
  const baseUrl = args.workerUrl.replace(/\/+$/, '');
  const url = new URL(`/auth/${encodeURIComponent(args.providerId)}`, `${baseUrl}/`);
  if (args.inviteCode) {
    url.searchParams.set('invite_code', args.inviteCode);
  }
  url.searchParams.set('return_to_origin', args.origin);
  return url.toString();
}
