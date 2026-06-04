export type DeployEnvironment = 'dev' | 'prod';

type BuildChrome = {
  headerClassName: string;
  topBarClassName: string;
  badgeClassName: string;
  faviconBackground: string;
  faviconForeground: string;
  themeColor: string;
};

function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeEnvironment(value: string | undefined): DeployEnvironment {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'prod' || normalized === 'production' ? 'prod' : 'dev';
}

const environment = normalizeEnvironment(
  optionalEnv(import.meta.env.VITE_DEPLOY_ENVIRONMENT) ?? import.meta.env.MODE
);
const commitHash = optionalEnv(import.meta.env.VITE_BUILD_COMMIT_HASH) ?? 'local';
const versionTag = environment === 'prod'
  ? optionalEnv(import.meta.env.VITE_BUILD_VERSION_TAG)
  : undefined;

export const buildInfo = {
  environment,
  label: environment === 'prod' ? 'prod' : 'dev',
  commitHash,
  shortCommitHash: commitHash === 'local' ? 'local' : commitHash.slice(0, 7),
  versionTag,
};

export function getBuildChrome(): BuildChrome {
  if (buildInfo.environment === 'prod') {
    return {
      headerClassName: 'border-cyan-300/60 bg-cyan-50/70 dark:border-cyan-500/25 dark:bg-cyan-950/20',
      topBarClassName: 'bg-cyan-400',
      badgeClassName: 'border-cyan-500/30 bg-cyan-100 text-cyan-800 dark:border-cyan-400/30 dark:bg-cyan-950 dark:text-cyan-200',
      faviconBackground: '#0a0a0a',
      faviconForeground: '#22d3ee',
      themeColor: '#0a0a0a',
    };
  }

  return {
    headerClassName: 'border-amber-300/70 bg-amber-50/85 dark:border-amber-500/30 dark:bg-amber-950/30',
    topBarClassName: 'bg-amber-500',
    badgeClassName: 'border-amber-500/35 bg-amber-100 text-amber-900 dark:border-amber-400/30 dark:bg-amber-950 dark:text-amber-200',
    faviconBackground: '#f59e0b',
    faviconForeground: '#111827',
    themeColor: '#f59e0b',
  };
}

export function applyBuildChrome() {
  const chrome = getBuildChrome();
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">',
    `<rect width="32" height="32" rx="6" fill="${chrome.faviconBackground}"/>`,
    `<text x="16" y="23" text-anchor="middle" font-family="system-ui, sans-serif" font-weight="700" font-size="20" fill="${chrome.faviconForeground}">V</text>`,
    '</svg>',
  ].join('');

  const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (favicon) {
    favicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) {
    themeColor.content = chrome.themeColor;
  }
}
