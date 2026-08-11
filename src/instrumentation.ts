/**
 * Process bootstrap.
 *
 * Runs once when the Next.js server starts, in the Node runtime only. It brings
 * the database up to schema, installs the proxy-aware outbound dispatcher,
 * reconciles runs that a restart interrupted, and restores previews for
 * projects that already have build output on disk.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { createLogger } = await import('@/lib/observability/logger');
  const log = createLogger('bootstrap');

  try {
    const { installGlobalDispatcher } = await import('@/lib/net/dispatcher');
    installGlobalDispatcher();

    const { db } = await import('@/lib/db/client');
    db();

    const { config } = await import('@/lib/config/env');
    const cfg = config();

    const { countUsers, createUser, purgeExpiredSessions } = await import('@/lib/security/auth');
    purgeExpiredSessions();
    if (countUsers() === 0 && cfg.BOOTSTRAP_ADMIN_EMAIL && cfg.BOOTSTRAP_ADMIN_PASSWORD) {
      await createUser({
        email: cfg.BOOTSTRAP_ADMIN_EMAIL,
        password: cfg.BOOTSTRAP_ADMIN_PASSWORD,
        role: 'admin',
        displayName: 'administrator',
      });
      log.info('bootstrap administrator created from the environment');
    }

    const { purgeExpiredCache } = await import('@/lib/cache');
    const { purgeExpiredHttpCache } = await import('@/lib/research/fetcher');
    purgeExpiredCache();
    purgeExpiredHttpCache();

    const { reconcileInterruptedRuns } = await import('@/lib/orchestrator/factory');
    const reconciled = reconcileInterruptedRuns();
    if (reconciled > 0) log.warn('marked interrupted runs as failed', { count: reconciled });

    const { listProjects } = await import('@/lib/workspace/project');
    const { restorePreviews } = await import('@/lib/preview/server');
    const restored = await restorePreviews(listProjects({ limit: 200 }));

    const { startScheduler } = await import('@/lib/schedule/scheduler');
    const scheduling = startScheduler();

    log.info('factory ready', {
      autonomy: cfg.AUTONOMY_MODE,
      previewsRestored: restored,
      scheduler: scheduling ? 'running' : 'disabled',
      database: cfg.databasePath,
    });
  } catch (error) {
    log.error('bootstrap failed', { error });
    throw error;
  }
}
