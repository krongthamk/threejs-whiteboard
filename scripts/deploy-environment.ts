import { xml } from '../packages/model/src/xml.js';

export interface DeploymentPaths { dataDirectory: string; staticDirectory: string }
const GOOGLE_SELECTORS = ['WHITEBOARD_GOOGLE_ENABLED', 'WHITEBOARD_GOOGLE_CLIENT_ID', 'WHITEBOARD_GOOGLE_CLIENT_SECRET',
  'WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE', 'WHITEBOARD_PUBLIC_URL', 'WHITEBOARD_GOOGLE_ALLOWED_DOMAINS',
  'WHITEBOARD_GOOGLE_ALLOWED_EMAILS'] as const;

/** Fixed local launch settings; importing this module never deploys or reads files. */
export function deploymentEnvironment(paths: DeploymentPaths, env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const environment: Record<string, string> = { WHITEBOARD_DATA_DIR: paths.dataDirectory, WHITEBOARD_STATIC_DIR: paths.staticDirectory,
    WHITEBOARD_ORIGINS: 'http://127.0.0.1:3001,http://localhost:3001', HOST: '127.0.0.1', PORT: '3001',
    NODE_ENV: 'production', WHITEBOARD_DRAIN_MS: '5000' };
  for (const key of GOOGLE_SELECTORS) if (env[key] !== undefined) environment[key] = env[key];
  return Object.freeze(environment);
}

/** Contents of the actual launch-agent EnvironmentVariables dictionary. */
export function deploymentEnvironmentXml(environment: Readonly<Record<string, string>>): string {
  return Object.entries(environment).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('');
}
