import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const DEFAULT_DATABASE_URL = 'postgresql://postgres:mysecretpassword@localhost:5432/postgres';
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 5477);
const CONNECTION_TIMEOUT_MS = 8000;
const QUERY_TIMEOUT_MS = 10000;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DatabaseKey = 'local' | 'prod';

type SandboxRequestBody = {
  databaseUrl?: string;
  databaseKey?: DatabaseKey;
  localDatabaseUrl?: string;
  prodDatabaseUrl?: string;
  sessionId?: string;
};

const logInfo = (message: string, details?: Record<string, unknown>) => {
  console.log(`[Modal Helper] ${message}`, details || {});
};

const summarizeDatabaseUrl = (databaseUrl: string) => {
  try {
    const parsedUrl = new URL(databaseUrl);

    return {
      database: parsedUrl.pathname.replace(/^\//, ''),
      hasPassword: Boolean(parsedUrl.password),
      hasUsername: Boolean(parsedUrl.username),
      host: parsedUrl.hostname,
      port: parsedUrl.port || 'default',
      protocol: parsedUrl.protocol,
      sslmode: parsedUrl.searchParams.get('sslmode') || 'not-set',
    };
  } catch {
    return {
      parseable: false,
    };
  }
};

const validateDatabaseUrl = (databaseUrl: string) => {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error('Database URL is not a valid URL.');
  }

  if (parsedUrl.protocol !== 'postgresql:' && parsedUrl.protocol !== 'postgres:') {
    throw new Error('Database URL must start with postgresql:// or postgres://.');
  }

  if (!parsedUrl.hostname) {
    throw new Error('Database URL is missing a host.');
  }

  if (!parsedUrl.pathname.replace(/^\//, '')) {
    throw new Error('Database URL is missing a database name.');
  }

  if (!parsedUrl.username) {
    throw new Error('Database URL is missing a username.');
  }

  if (!parsedUrl.password) {
    throw new Error('Database URL is missing a password. Use postgresql://user:password@host:5432/db?sslmode=require.');
  }
};

const getSslConfig = (databaseUrl: string) => {
  try {
    const parsedUrl = new URL(databaseUrl);
    const sslMode = parsedUrl.searchParams.get('sslmode');

    if (sslMode === 'require' || sslMode === 'no-verify') {
      return {
        rejectUnauthorized: false,
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const getConnectionString = (databaseUrl: string) => {
  try {
    const parsedUrl = new URL(databaseUrl);

    parsedUrl.searchParams.delete('sslmode');

    return parsedUrl.toString();
  } catch {
    return databaseUrl;
  }
};

const sendJson = (response: ServerResponse, statusCode: number, body: object) => {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  });
  response.end(JSON.stringify(body));
};

const readRequestBody = async (request: IncomingMessage) =>
  new Promise<SandboxRequestBody>((resolve, reject) => {
    let body = '';

    request.on('data', chunk => {
      body += chunk.toString();

      if (body.length > 10000) {
        request.destroy();
        reject(new Error('Request body is too large.'));
      }
    });

    request.on('end', () => {
      logInfo('Request body read', { bytes: body.length });

      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body) as SandboxRequestBody);
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });

    request.on('error', reject);
  });

const findModalId = async (sessionId: string, databaseUrl: string) => {
  validateDatabaseUrl(databaseUrl);

  logInfo('Connecting to Postgres', {
    connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
    database: summarizeDatabaseUrl(databaseUrl),
    queryTimeoutMs: QUERY_TIMEOUT_MS,
    sessionId,
    sslEnabled: Boolean(getSslConfig(databaseUrl)),
  });

  const pool = new Pool({
    connectionString: getConnectionString(databaseUrl),
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    ssl: getSslConfig(databaseUrl),
    statement_timeout: QUERY_TIMEOUT_MS,
  });

  try {
    const startedAt = Date.now();
    const result = await pool.query<{ modal_id: string }>(
      'select modal_id from agent_session_sandbox where session_id = $1 order by created_at desc limit 1',
      [sessionId],
    );
    const elapsedMs = Date.now() - startedAt;

    logInfo('Postgres query finished', {
      elapsedMs,
      rowCount: result.rowCount,
      sessionId,
    });

    return result.rows[0]?.modal_id || null;
  } finally {
    await pool.end();
  }
};

const getDatabaseUrl = (body: SandboxRequestBody) => {
  if (body.databaseUrl) {
    logInfo('Using legacy databaseUrl request field', {
      database: summarizeDatabaseUrl(body.databaseUrl),
    });

    return body.databaseUrl;
  }

  if (!body.databaseKey) {
    const databaseUrl = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;

    logInfo('Using default database URL', {
      database: summarizeDatabaseUrl(databaseUrl),
    });

    return databaseUrl;
  }

  if (body.databaseKey !== 'local' && body.databaseKey !== 'prod') {
    throw new Error('databaseKey must be local or prod.');
  }

  const databaseUrl = body.databaseKey === 'prod' ? body.prodDatabaseUrl : body.localDatabaseUrl;

  if (!databaseUrl) {
    throw new Error(`Missing ${body.databaseKey} database URL.`);
  }

  logInfo('Selected database URL from request', {
    database: summarizeDatabaseUrl(databaseUrl),
    databaseKey: body.databaseKey,
    hasLocalDatabaseUrl: Boolean(body.localDatabaseUrl),
    hasProdDatabaseUrl: Boolean(body.prodDatabaseUrl),
  });

  return databaseUrl;
};

const server = createServer(async (request, response) => {
  logInfo('Request received', {
    method: request.method,
    url: request.url,
  });

  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return;
  }

  if (!request.url) {
    sendJson(response, 400, { error: 'Missing request URL.' });
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

  if ((request.method !== 'GET' && request.method !== 'POST') || url.pathname !== '/sandbox-id') {
    logInfo('Request rejected: route not found', {
      method: request.method,
      pathname: url.pathname,
    });
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }

  let body: SandboxRequestBody = {};

  try {
    if (request.method === 'POST') {
      body = await readRequestBody(request);
    }
  } catch (error) {
    let message = 'Invalid request body.';

    if (error instanceof Error) {
      message = error.message;
    }

    sendJson(response, 400, { error: message });
    logInfo('Request rejected: invalid body', { message });
    return;
  }

  const sessionId = body.sessionId || url.searchParams.get('sessionId');

  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
    logInfo('Request rejected: invalid session ID', {
      hasSessionId: Boolean(sessionId),
      sessionId,
    });
    sendJson(response, 400, { error: 'A valid sessionId query parameter is required.' });
    return;
  }

  let databaseUrl: string;

  try {
    databaseUrl = getDatabaseUrl(body);
  } catch (error) {
    let message = 'Invalid database settings.';

    if (error instanceof Error) {
      message = error.message;
    }

    sendJson(response, 400, { error: message });
    logInfo('Request rejected: invalid database settings', { message });
    return;
  }

  try {
    const modalId = await findModalId(sessionId, databaseUrl);

    if (!modalId) {
      logInfo('No Modal sandbox found', { sessionId });
      sendJson(response, 404, { error: 'No Modal sandbox was found for this session.' });
      return;
    }

    logInfo('Modal sandbox found', { modalId, sessionId });
    sendJson(response, 200, { modalId });
  } catch (error) {
    console.error('Failed to look up Modal sandbox ID', error);
    sendJson(response, 500, { error: 'Failed to query Postgres for this session.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Modal helper listening on http://${HOST}:${PORT}`);
});

const shutdown = async () => {
  server.close();
};

process.on('SIGINT', () => {
  shutdown()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
});

process.on('SIGTERM', () => {
  shutdown()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
});
