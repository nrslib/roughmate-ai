import { environmentFence } from './environment-lease.js';
import { type BucketLocationConstraint, S3Client, HeadBucketCommand, CreateBucketCommand, GetBucketTaggingCommand, GetBucketVersioningCommand, GetBucketEncryptionCommand, GetPublicAccessBlockCommand, PutBucketTaggingCommand, PutBucketVersioningCommand, PutBucketEncryptionCommand, PutPublicAccessBlockCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { LambdaClient, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import { ApiGatewayV2Client, GetApiCommand } from '@aws-sdk/client-apigatewayv2';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { AppError, string, validateSecrets, type Secrets } from '../../app/src/contracts.js';
import { location, validateDescriptor, validateRemovalRecord, type Target, type Descriptor, type RemovalRecord } from './config.js';
export class SetupAws {
  readonly s3: S3Client;
  readonly secrets: SecretsManagerClient;
  readonly db: DynamoDBDocumentClient;
  private readonly lambda: LambdaClient;
  private readonly gateway: ApiGatewayV2Client;
  constructor(readonly target: Target) {
    this.s3 = new S3Client({ region: target.region, requestHandler: { requestTimeout:20_000, throwOnRequestTimeout:true, connectionTimeout:3000 } });
    this.secrets = new SecretsManagerClient({ region: target.region });
    this.db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: target.region }));
    this.lambda = new LambdaClient({ region: target.region });
    this.gateway = new ApiGatewayV2Client({ region: target.region });
  }
  static async account(region: string): Promise<string> {
    try { return string((await new STSClient({ region }).send(new GetCallerIdentityCommand({}))).Account); }
    catch (error) {
      if (error instanceof Error && ['CredentialsProviderError','InvalidClientTokenId','ExpiredToken','ExpiredTokenException','UnrecognizedClientException'].includes(error.name)) throw new AppError('aws_authentication');
      throw error;
    }
  }
  async verifyStateBucket(): Promise<void> {
    const input = { Bucket: location(this.target).bucket, ExpectedBucketOwner: this.target.accountId };
    try {
      const tags = await this.s3.send(new GetBucketTaggingCommand(input));
      if (!tags.TagSet?.some(tag => tag.Key === 'Application' && tag.Value === 'roughmate-self-hosted-state')) throw new AppError('bucket_ownership_mismatch');
      const versioning = await this.s3.send(new GetBucketVersioningCommand(input));
      const encryption = await this.s3.send(new GetBucketEncryptionCommand(input));
      const access = (await this.s3.send(new GetPublicAccessBlockCommand(input))).PublicAccessBlockConfiguration;
      if (versioning.Status !== 'Enabled' || !encryption.ServerSideEncryptionConfiguration?.Rules?.some(rule => rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm === 'AES256') || !access?.BlockPublicAcls || !access.IgnorePublicAcls || !access.BlockPublicPolicy || !access.RestrictPublicBuckets) throw new AppError('state_bucket_not_ready');
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Error && ['NoSuchBucket','NoSuchTagSet','NoSuchPublicAccessBlockConfiguration','ServerSideEncryptionConfigurationNotFoundError'].includes(error.name)) throw new AppError('state_bucket_not_ready');
      throw new AppError('aws_bucket_access');
    }
  }
  async bootstrap(): Promise<void> {
    const { bucket } = location(this.target);
    let exists = false;
    try { await this.s3.send(new HeadBucketCommand({ Bucket: bucket, ExpectedBucketOwner: this.target.accountId })); exists = true; }
    catch (error) { if (!(error instanceof Error) || !['NotFound','NoSuchBucket'].includes(error.name)) throw new AppError('aws_bucket_access'); }
    try {
      if (!exists) {
        await this.s3.send(new CreateBucketCommand({ Bucket: bucket, ...(this.target.region !== 'us-east-1' ? { CreateBucketConfiguration: { LocationConstraint: this.target.region as BucketLocationConstraint } } : {}) }));
        await this.s3.send(new PutBucketTaggingCommand({ Bucket: bucket, Tagging: { TagSet: [{ Key: 'Application', Value: 'roughmate-self-hosted-state' }] } }));
      } else {
        const tags = await this.s3.send(new GetBucketTaggingCommand({ Bucket: bucket, ExpectedBucketOwner: this.target.accountId }));
        if (!tags.TagSet?.some(tag => tag.Key === 'Application' && tag.Value === 'roughmate-self-hosted-state')) throw new AppError('bucket_ownership_mismatch');
      }
      await this.s3.send(new PutPublicAccessBlockCommand({ Bucket: bucket, ExpectedBucketOwner: this.target.accountId, PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }));
      await this.s3.send(new PutBucketEncryptionCommand({ Bucket: bucket, ExpectedBucketOwner: this.target.accountId, ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] } }));
      await this.s3.send(new PutBucketVersioningCommand({ Bucket: bucket, ExpectedBucketOwner: this.target.accountId, VersioningConfiguration: { Status: 'Enabled' } }));
    } catch (error) {
      if (!(error instanceof AppError) && error instanceof Error && ['AccessDenied','Forbidden'].includes(error.name)) throw new AppError('aws_bootstrap_permission');
      throw error;
    }
  }
  async descriptor(): Promise<Descriptor> {
    const place = location(this.target);
    let raw: string;
    try {
      const result = await this.s3.send(new GetObjectCommand({ Bucket: place.bucket, Key: place.descriptorKey, ExpectedBucketOwner: this.target.accountId }));
      raw = string(await result.Body?.transformToString());
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      throw new AppError(['NoSuchKey','NoSuchBucket'].includes(name) ? 'aws_not_deployed' : ['AccessDenied','Forbidden'].includes(name) ? 'aws_permission' : 'aws_descriptor_unavailable');
    }
    const checked = validateDescriptor(JSON.parse(raw), this.target);
    await this.verifyPublicEndpoint(checked);
    return checked;
  }
  private async verifyPublicEndpoint(descriptor: Descriptor): Promise<void> {
    const name = `roughmate-${this.target.environment}`;
    const functionArn = `arn:aws:lambda:${this.target.region}:${this.target.accountId}:function:${name}-http`;
    try {
      const config = await this.lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionArn }));
      if (config.FunctionArn !== functionArn) throw new AppError('target_mismatch');
      if (config.Environment?.Error || !config.Environment?.Variables?.PUBLIC_URL) throw new AppError('aws_endpoint_unavailable');
      const publicUrl = config.Environment.Variables.PUBLIC_URL;
      validateDescriptor({ ...descriptor, publicUrl }, this.target);
      if (descriptor.publicUrl !== publicUrl) throw new AppError('target_mismatch');
      const apiId = new URL(publicUrl).hostname.split('.')[0];
      const api = await this.gateway.send(new GetApiCommand({ ApiId: apiId }));
      if (api.ApiId !== apiId || api.ApiEndpoint !== publicUrl || api.Name !== name || api.ProtocolType !== 'HTTP' || api.DisableExecuteApiEndpoint === true || api.Tags?.Application !== 'roughmate-self-hosted' || api.Tags?.Environment !== this.target.environment) throw new AppError('target_mismatch');
    } catch (error) {
      if (error instanceof AppError) throw error;
      const name = error instanceof Error ? error.name : '';
      throw new AppError(['ResourceNotFoundException','NotFoundException'].includes(name) ? 'aws_not_deployed' : name === 'AccessDeniedException' ? 'aws_endpoint_permission' : 'aws_endpoint_unavailable');
    }
  }
  async saveDescriptor(value: Descriptor): Promise<void> {
    await environmentFence();
    const checked = validateDescriptor(value, this.target);
    const place = location(this.target);
    await this.s3.send(new PutObjectCommand({ Bucket: place.bucket, Key: place.descriptorKey, ExpectedBucketOwner: this.target.accountId, Body: JSON.stringify(checked), ContentType: 'application/json', ServerSideEncryption: 'AES256' }));
  }
  async removeDescriptor(): Promise<void> {
    await environmentFence();
    const place = location(this.target);
    await this.s3.send(new DeleteObjectCommand({ Bucket: place.bucket, Key: place.descriptorKey, ExpectedBucketOwner: this.target.accountId }));
  }
  async removal(): Promise<RemovalRecord | undefined> {
    const place = location(this.target);
    let raw: string;
    try {
      const result = await this.s3.send(new GetObjectCommand({ Bucket: place.bucket, Key: place.removalKey, ExpectedBucketOwner: this.target.accountId }));
      raw = string(await result.Body?.transformToString());
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (['NoSuchKey','NoSuchBucket'].includes(name)) return undefined;
      throw new AppError(['AccessDenied','Forbidden'].includes(name) ? 'aws_permission' : 'aws_descriptor_unavailable');
    }
    return validateRemovalRecord(JSON.parse(raw), this.target);
  }
  async saveRemoval(value: RemovalRecord): Promise<void> {
    await environmentFence();
    const checked = validateRemovalRecord(value, this.target);
    const place = location(this.target);
    await this.s3.send(new PutObjectCommand({ Bucket: place.bucket, Key: place.removalKey, ExpectedBucketOwner: this.target.accountId, Body: JSON.stringify(checked), ContentType: 'application/json', ServerSideEncryption: 'AES256' }));
  }
  async removeRemoval(): Promise<void> {
    await environmentFence();
    const place = location(this.target);
    await this.s3.send(new DeleteObjectCommand({ Bucket: place.bucket, Key: place.removalKey, ExpectedBucketOwner: this.target.accountId }));
  }
  async readSecrets(descriptor: Descriptor): Promise<Secrets | undefined> {
    try {
      const result = await this.secrets.send(new GetSecretValueCommand({ SecretId: descriptor.secretArn }));
      return validateSecrets(JSON.parse(string(result.SecretString)));
    } catch (error) { if (error instanceof Error && error.name === 'ResourceNotFoundException') return undefined; throw error; }
  }
  async saveSecrets(descriptor: Descriptor, value: Secrets): Promise<void> {
    await environmentFence();
    await this.secrets.send(new PutSecretValueCommand({ SecretId: descriptor.secretArn, SecretString: JSON.stringify(validateSecrets(value)) }));
  }
}
