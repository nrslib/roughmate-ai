import { AppError, object, string } from '../../app/src/contracts.js';
import { slackClient } from './leased-slack.js';
import { slackDeletionCode } from '../../app/src/bot-maintenance.js';
import { requireSlackAppTarget } from './config.js';
import type { SetupInteraction } from './slack-setup.js';
import type { PurgeJournal } from './purge-journal.js';
import type { PurgePlan, PurgeApp } from './purge-model.js';
export async function purgeSlack(plan: PurgePlan, interaction: SetupInteraction, deleting: boolean, journal: PurgeJournal): Promise<PurgePlan> {
  if (!plan.apps.length || !plan.apps.some(app => !app.registrationId))
    throw new AppError('purge_journal');
  const refresh = string(await interaction.password({ message: 'Root OAuth ownerが新しく生成した未使用のSlack Configuration Refresh Token（非表示）:', mask: '*' }));
  const rotated = await slackClient(undefined, undefined, 30000).tooling.tokens.rotate({ refresh_token: refresh });
  if (rotated.ok !== true || 'error' in rotated || rotated.user_id !== plan.ownerId || rotated.team_id !== plan.teamId || !Number.isSafeInteger(Number(rotated.exp)) || Number(rotated.exp) <= Math.floor(Date.now() / 1000))
    throw new AppError('purge_owner_mismatch');
  const client = slackClient(string(rotated.token), undefined, 30000);
  const exists = async (app: PurgeApp): Promise<boolean> => {
    try {
      plan = await journal.save(plan);
      const response = await client.apps.manifest.export({ app_id: app.appId });
      if (response.ok !== true || 'error' in response || !response.manifest)
        throw new AppError('purge_slack_unknown');
      const manifest = object(response.manifest);
      const descriptor = { ...plan.descriptor, publicUrl: app.publicUrl ?? plan.descriptor.publicUrl };
      if (!app.registrationId)
        requireSlackAppTarget(manifest, descriptor);
      else {
        const marker = `Registration: ${descriptor.publicUrl}/bots/${app.registrationId}`;
        if (!string(object(manifest.display_information).long_description).endsWith(marker) || app.botName !== undefined && object(object(manifest.features).bot_user).display_name !== app.botName)
          throw new AppError('purge_ownership');
        const base = `${descriptor.publicUrl}/bots/${app.registrationId}`;
        if (manifest.oauth_config !== undefined) {
          const redirects = object(manifest.oauth_config).redirect_urls;
          if (redirects !== undefined && (!Array.isArray(redirects) || redirects.some(url => ![`${base}/oauth/callback`, `${base}/channel-authorization/callback`].includes(String(url)))))
            throw new AppError('purge_ownership');
        }
        if (manifest.settings !== undefined) {
          const settings = object(manifest.settings);
          for (const [key, path] of [['event_subscriptions', '/slack/events'], ['interactivity', '/slack/interactive']]) {
            if (settings[key] !== undefined && object(settings[key]).request_url !== `${base}${path}`)
              throw new AppError('purge_ownership');
          }
        }
      }
      return true;
    }
    catch (error) {
      if (slackDeletionCode(error) === 'app_not_found')
        return false;
      throw error;
    }
  };
  // Validate every visible identity before the first irreversible call.
  const present: PurgeApp[] = [];
  for (const app of plan.apps)
    if (await exists(app))
      present.push(app);
  if (!deleting && present.length)
    throw new AppError('purge_slack_still_present');
  for (const app of present) {
    if (!await exists(app))
      continue;
    plan = await journal.save(plan);
    const response = await client.apps.manifest.delete({ app_id: app.appId });
    if (response.ok !== true || 'error' in response)
      throw new AppError('purge_slack_unknown');
  }
  // A successful delete response alone never authorizes AWS data erasure.
  for (const app of plan.apps)
    if (await exists(app))
      throw new AppError('purge_slack_unknown');
  return plan;
}
