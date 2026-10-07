output "setup" {
  value = {
    schemaVersion = 1
    application   = "roughmate-self-hosted"
    accountId     = var.account_id
    region        = var.region
    environment   = var.environment
    publicUrl     = aws_apigatewayv2_api.http.api_endpoint
    secretArn     = aws_secretsmanager_secret.runtime.arn
    tableName     = aws_dynamodb_table.app.name
    queueUrl      = aws_sqs_queue.jobs.url
  }
}
