import { AppError, object, string } from '../../app/src/contracts.js';
import type { Target } from './config.js';
import { roleKinds, validateResource, type PurgeResource } from './purge-model.js';
export function stateResources(raw: unknown, target: Target): PurgeResource[] {
  const state = object(raw);
  if (state.version !== 4 || !Array.isArray(state.resources))
    throw new AppError('purge_terraform_scope');
  const result: PurgeResource[] = [], base = `roughmate-${target.environment}`;
  const regional = (service: string, suffix: string) => `arn:aws:${service}:${target.region}:${target.accountId}:${suffix}`;
  const apiIds = new Set<string>();
  for (const rawResource of state.resources) {
    const source = object(rawResource);
    if (source.mode === 'managed' && source.type === 'aws_apigatewayv2_api' && Array.isArray(source.instances))
      for (const rawInstance of source.instances) {
        const a = object(object(rawInstance).attributes);
        if (a.name !== base || !/^[a-z0-9]+$/.test(string(a.id)))
          throw new AppError('purge_terraform_scope');
        apiIds.add(string(a.id));
      }
  }
  const apiParent = (value: unknown): PurgeResource => { const id = string(value); if (!apiIds.has(id))
    throw new AppError('purge_terraform_scope'); return { kind: 'api', id, arn: `arn:aws:apigateway:${target.region}::/apis/${id}`, publicUrl: `https://${id}.execute-api.${target.region}.amazonaws.com` }; };
  const roleParent = (value: unknown): PurgeResource => { const id = string(value); if (!roleKinds.some(kind => id === `${base}-${target.region}-${kind}`))
    throw new AppError('purge_terraform_scope'); return { kind: 'role', id, arn: `arn:aws:iam::${target.accountId}:role/${id}` }; };
  for (const resourceRaw of state.resources) {
    const source = object(resourceRaw);
    if (source.mode === 'data')
      continue;
    if (source.mode !== 'managed' || source.module !== undefined || !Array.isArray(source.instances) || !['aws_dynamodb_table', 'aws_secretsmanager_secret', 'aws_lambda_function', 'aws_sqs_queue', 'aws_cloudwatch_log_group', 'aws_iam_role', 'aws_apigatewayv2_api', 'aws_scheduler_schedule_group', 'aws_lambda_event_source_mapping', 'aws_iam_role_policy', 'aws_apigatewayv2_route', 'aws_apigatewayv2_stage', 'aws_apigatewayv2_integration', 'aws_lambda_permission', 'aws_scheduler_schedule'].includes(String(source.type)))
      throw new AppError('purge_terraform_scope');
    for (const instance of source.instances) {
      const a = object(object(instance).attributes);
      let r: PurgeResource | undefined;
      switch (source.type) {
        case 'aws_dynamodb_table':
          r = { kind: 'table', id: string(a.name), arn: string(a.arn), ...(String(a.name).includes('-bot-') ? { registrationId: String(a.name).split('-bot-').at(-1) } : {}) };
          break;
        case 'aws_secretsmanager_secret':
          r = { kind: 'secret', id: string(a.name), arn: string(a.arn), ...(/\/bots\/([a-f0-9]{32})\//.test(String(a.name)) ? { registrationId: /\/bots\/([a-f0-9]{32})\//.exec(String(a.name))![1] } : {}) };
          break;
        case 'aws_lambda_function':
          r = { kind: 'function', id: string(a.function_name), arn: string(a.arn) };
          break;
        case 'aws_sqs_queue':
          r = { kind: 'queue', id: string(a.id), arn: string(a.arn) };
          break;
        case 'aws_cloudwatch_log_group':
          r = { kind: 'log', id: string(a.name), arn: string(a.arn).replace(/:\*$/, '') };
          break;
        case 'aws_iam_role':
          r = { kind: 'role', id: string(a.name), arn: string(a.arn) };
          break;
        case 'aws_apigatewayv2_api':
          r = { kind: 'api', id: string(a.id), arn: `arn:aws:apigateway:${target.region}::/apis/${string(a.id)}`, publicUrl: `https://${string(a.id)}.execute-api.${target.region}.amazonaws.com` };
          break;
        case 'aws_scheduler_schedule_group':
          r = { kind: 'schedule-group', id: string(a.name), arn: string(a.arn) };
          break;
        case 'aws_lambda_event_source_mapping':
          if (!['worker', 'provisioner', 'wiki-runner'].some((kind, index) => [`${base}-${kind}`, regional('lambda', `function:${base}-${kind}`)].includes(String(a.function_name)) && a.event_source_arn === regional('sqs', `${base}-${['jobs', 'provision', 'wiki'][index]}`)))
            throw new AppError('purge_terraform_scope');
          r = { kind: 'mapping', id: string(a.id), arn: `arn:aws:lambda:${target.region}:${target.accountId}:event-source-mapping:${string(a.id)}` };
          break;
        case 'aws_iam_role_policy':
          r = roleParent(a.role);
          break;
        case 'aws_apigatewayv2_route':
          r = apiParent(a.api_id);
          if (typeof a.target !== 'string' || !a.target.startsWith('integrations/') || !state.resources.some(raw => { const source = object(raw); return source.mode === 'managed' && source.type === 'aws_apigatewayv2_integration' && Array.isArray(source.instances) && source.instances.some(raw => { const integration = object(object(raw).attributes); return integration.api_id === a.api_id && `integrations/${integration.id}` === a.target; }); }))
            throw new AppError('purge_terraform_scope');
          break;
        case 'aws_apigatewayv2_stage':
          r = apiParent(a.api_id);
          if (a.name !== '$default')
            throw new AppError('purge_terraform_scope');
          break;
        case 'aws_apigatewayv2_integration':
          r = apiParent(a.api_id);
          if (a.integration_type !== 'AWS_PROXY' || a.integration_uri !== `arn:aws:apigateway:${target.region}:lambda:path/2015-03-31/functions/${regional('lambda', `function:${base}-http`)}/invocations`)
            throw new AppError('purge_terraform_scope');
          break;
        case 'aws_lambda_permission':
          if (![`${base}-http`, regional('lambda', `function:${base}-http`)].includes(String(a.function_name)) || a.action !== 'lambda:InvokeFunction' || a.principal !== 'apigateway.amazonaws.com' || ![...apiIds].some(id => a.source_arn === regional('execute-api', `${id}/*/*`)))
            throw new AppError('purge_terraform_scope');
          r = { kind: 'function', id: `${base}-http`, arn: regional('lambda', `function:${base}-http`) };
          break;
        case 'aws_scheduler_schedule': {
          if (a.name !== `${base}-configuration-refresh` || a.group_name !== `${base}-configuration` || !Array.isArray(a.target) || a.target.length !== 1)
            throw new AppError('purge_terraform_scope');
          const targetConfig = object(a.target[0]);
          if (targetConfig.arn !== regional('sqs', `${base}-provision`) || targetConfig.role_arn !== `arn:aws:iam::${target.accountId}:role/${base}-${target.region}-scheduler`)
            throw new AppError('purge_terraform_scope');
          r = { kind: 'schedule-group', id: `${base}-configuration`, arn: regional('scheduler', `schedule-group/${base}-configuration`) };
          break;
        }
        default: throw new AppError('purge_terraform_scope');
      }
      if (r) {
        validateResource(r, target);
        result.push(r);
      }
    }
  }
  return result;
}
