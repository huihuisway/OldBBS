import 'dotenv/config';

const bool = (value: string | undefined, fallback: boolean) => value === undefined ? fallback : value === 'true';
const integer = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};
const proxySetting = (value: string | undefined): boolean | number | string => {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return 1;
  const hops = Number(value);
  return Number.isInteger(hops) && hops >= 0 ? hops : value;
};

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  appHost: process.env.APP_HOST ?? '0.0.0.0',
  appPort: integer(process.env.APP_PORT, 3000),
  appUrl: process.env.APP_URL ?? 'http://localhost:3000',
  database: {
    host: process.env.DATABASE_HOST ?? '127.0.0.1',
    port: integer(process.env.DATABASE_PORT, 3306),
    user: process.env.DATABASE_USER ?? 'oldbbs',
    password: process.env.DATABASE_PASSWORD ?? '',
    name: process.env.DATABASE_NAME ?? 'oldbbs',
    socketPath: process.env.DATABASE_SOCKET_PATH,
  },
  redis: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: integer(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD,
  },
  sessionSecret: process.env.SESSION_SECRET ?? '',
  sessionTtlSeconds: integer(process.env.SESSION_TTL_SECONDS, 1209600),
  cookieSecure: bool(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production'),
  trustProxy: proxySetting(process.env.TRUST_PROXY),
  registrationEnabled: bool(process.env.REGISTRATION_ENABLED, true),
  uploadDir: process.env.UPLOAD_DIR ?? './data/uploads',
  attachmentScanner: process.env.ATTACHMENT_SCANNER ?? 'disabled',
  clamavCommand: process.env.CLAMAV_COMMAND ?? 'clamscan',
  terminal: {
    maxConnections: integer(process.env.TERMINAL_MAX_CONNECTIONS, 300),
    maxConnectionsPerIp: integer(process.env.TERMINAL_MAX_CONNECTIONS_PER_IP, 8),
    idleTimeoutMs: integer(process.env.TERMINAL_IDLE_TIMEOUT_MS, 20 * 60_000),
    authTimeoutMs: integer(process.env.TERMINAL_AUTH_TIMEOUT_MS, 45_000),
    maxLifetimeMs: integer(process.env.TERMINAL_MAX_LIFETIME_MS, 12 * 60 * 60_000),
    maxShellsPerMinute: integer(process.env.SSH_SHELLS_PER_MINUTE, 3),
    commandRateLimit: integer(process.env.TERMINAL_COMMAND_RATE_LIMIT, 60),
    expensiveCommandRateLimit: integer(process.env.TERMINAL_EXPENSIVE_COMMAND_RATE_LIMIT, 12),
  },
  ssh: {
    enabled: bool(process.env.SSH_ENABLED, true),
    host: process.env.SSH_HOST ?? '0.0.0.0',
    port: integer(process.env.SSH_PORT, 2322),
    hostKeyPath: process.env.SSH_HOST_KEY_PATH ?? (process.env.NODE_ENV === 'production' ? '/var/lib/oldbbs/ssh_host_ed25519' : './data/ssh_host_ed25519'),
    maxChannelsPerConnection: integer(process.env.SSH_MAX_CHANNELS_PER_CONNECTION, 4),
    maxShellsPerConnection: integer(process.env.SSH_MAX_SHELLS_PER_CONNECTION, 1),
  },
  telnet: {
    enabled: bool(process.env.TELNET_ENABLED, true),
    host: process.env.TELNET_HOST ?? '0.0.0.0',
    port: integer(process.env.TELNET_PORT, 2323),
  },
};

if (!['disabled', 'development', 'clamav'].includes(config.attachmentScanner)) {
  throw new Error('ATTACHMENT_SCANNER must be disabled, development, or clamav');
}
if (config.attachmentScanner === 'development' && config.nodeEnv === 'production') {
  throw new Error('ATTACHMENT_SCANNER=development is not allowed in production');
}

if (config.sessionSecret.length < 32 && config.nodeEnv === 'production') {
  throw new Error('SESSION_SECRET must contain at least 32 characters in production');
}
