/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_BUILD_COMMIT_HASH?: string;
  readonly VITE_BUILD_VERSION_TAG?: string;
  readonly VITE_DEPLOY_ENVIRONMENT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
