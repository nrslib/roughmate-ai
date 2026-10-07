import { purgeHistoryEvidence } from './purge-evidence.js';
import { isDeepStrictEqual } from 'node:util';
import { stateResources, inspectResource } from './purge-resources.js';
import { AppError, object, string } from '../../app/src/contracts.js';
import { location } from './config.js';
import { readStateJson } from './purge-journal.js';
import type { PurgeAwsCli } from './purge-inventory.js';
import { requireRootTags, validateResource, type PurgePlan, type PurgeResource } from './purge-model.js';
import type { SetupAws } from './aws.js';

export async function validatePurgeState(aws: SetupAws, plan: PurgePlan, cli: PurgeAwsCli): Promise<boolean> {
  const resources: PurgeResource[] = [];
  const history = await purgeHistoryEvidence(aws);
  for (const state of history.states) for (const resource of stateResources(state,aws.target)) {
    if (!resources.some(previous => isDeepStrictEqual(previous,resource))) resources.push(resource);
  }
  process.stdout.write(`過去state ${history.states.length}版の構造・所有範囲を検証しました。重複を除いた${resources.length}資源をAWSで照合します。\n`);
  for(const resource of resources) {
    const live=await inspectResource(cli,resource,plan.descriptor);if(live&&!plan.resources.some(saved=>saved.kind===resource.kind&&saved.id===resource.id&&saved.arn===resource.arn))throw new AppError('purge_inventory_changed');
  }
  const saved = await readStateJson(aws, location(aws.target).stateKey);
  if (!saved) return false;
  const state = object(saved.value);
  if (state.version !== 4 || !Array.isArray(state.resources)) throw new AppError('purge_terraform_scope');
  const base = `roughmate-${aws.target.environment}`;
  const functionNames = plan.resources.filter(resource => resource.kind === 'function').map(resource => resource.id);
  const apiIds = new Set([...plan.resources.filter(resource => resource.kind === 'api').map(resource => resource.id),new URL(plan.descriptor.publicUrl).hostname.split('.')[0]]);
  const regional = (service: string, suffix: string) => `arn:aws:${service}:${aws.target.region}:${aws.target.accountId}:${suffix}`;
  for (const raw of state.resources) {
    const resource = object(raw);
    if (resource.mode === 'data') continue;
    if (resource.mode !== 'managed' || resource.module !== undefined || !Array.isArray(resource.instances)) throw new AppError('purge_terraform_scope');
    for (const rawInstance of resource.instances) {
      const attributes = object(object(rawInstance).attributes);
      switch (resource.type) {
        case 'aws_dynamodb_table': validateResource({kind:'table',id:string(attributes.name),arn:string(attributes.arn)},aws.target); break;
        case 'aws_secretsmanager_secret': validateResource({kind:'secret',id:string(attributes.name),arn:string(attributes.arn)},aws.target); break;
        case 'aws_sqs_queue': validateResource({kind:'queue',id:string(attributes.id),arn:string(attributes.arn)},aws.target); break;
        case 'aws_lambda_function': validateResource({kind:'function',id:string(attributes.function_name),arn:string(attributes.arn)},aws.target); break;
        case 'aws_cloudwatch_log_group': validateResource({kind:'log',id:string(attributes.name),arn:string(attributes.arn).replace(/:\*$/,'')},aws.target); break;
        case 'aws_iam_role': validateResource({kind:'role',id:string(attributes.name),arn:string(attributes.arn)},aws.target); break;
        case 'aws_iam_role_policy':
          if (!['http','worker','wiki-runner','provisioner','scheduler'].some(kind => attributes.role === `${base}-${aws.target.region}-${kind}`)) throw new AppError('purge_terraform_scope'); break;
        case 'aws_apigatewayv2_api':
          if (attributes.name !== base || !apiIds.has(string(attributes.id))) throw new AppError('purge_terraform_scope');
          { const live = await cli.optional('apigatewayv2','get-api',{ApiId:attributes.id},['NotFoundException']);
            if (live) { requireRootTags(object(live.Tags) as Record<string,string>,aws.target); if (live.Name !== base || live.ApiId !== attributes.id || attributes.id !== new URL(plan.descriptor.publicUrl).hostname.split('.')[0] || live.ProtocolType !== 'HTTP' || live.ApiEndpoint !== plan.descriptor.publicUrl) throw new AppError('purge_terraform_scope'); }
          } break;
        case 'aws_apigatewayv2_route': case 'aws_apigatewayv2_stage': case 'aws_apigatewayv2_integration':
          if (!apiIds.has(string(attributes.api_id))) throw new AppError('purge_terraform_scope'); break;
        case 'aws_lambda_permission':
          if (!functionNames.includes(string(attributes.function_name)) && !['http','worker','wiki-runner','provisioner'].some(kind => attributes.function_name === `${base}-${kind}` || attributes.function_name === regional('lambda',`function:${base}-${kind}`))) throw new AppError('purge_terraform_scope'); break;
        case 'aws_lambda_event_source_mapping':
          if (!['jobs','provision','wiki'].some(kind => attributes.event_source_arn === regional('sqs',`${base}-${kind}`)) || !['worker','wiki-runner','provisioner'].some(kind => attributes.function_name === regional('lambda',`function:${base}-${kind}`) || attributes.function_name === `${base}-${kind}`)) throw new AppError('purge_terraform_scope');
          { const live = await cli.optional('lambda','get-event-source-mapping',{UUID:attributes.id},['ResourceNotFoundException']);
            if (live && (live.FunctionArn !== attributes.function_name || live.EventSourceArn !== attributes.event_source_arn)) throw new AppError('purge_terraform_scope');
          } break;
        case 'aws_scheduler_schedule_group': validateResource({kind:'schedule-group',id:string(attributes.name),arn:string(attributes.arn)},aws.target); break;
        case 'aws_scheduler_schedule':
          if (attributes.name !== `${base}-configuration-refresh` || attributes.group_name !== `${base}-configuration`) throw new AppError('purge_terraform_scope'); break;
        default: throw new AppError('purge_terraform_scope');
      }
    }
  }
  return true;
}
