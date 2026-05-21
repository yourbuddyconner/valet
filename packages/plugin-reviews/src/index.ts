/**
 * @valet/plugin-reviews
 *
 * Reviews integration plugin — provides a skill that instructs agents to push
 * review packets to Reviews before creating GitHub PRs, and exports the CLI
 * installer for runner startup.
 */

export { installReviewsCli } from './install.js';
export type { InstallResult } from './install.js';
