locals {
  name = "roughmate-${var.environment}"
  wiki_dynamodb_statements = [
    {
      Sid      = "WikiReads"
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem"]
      Resource = [aws_dynamodb_table.app.arn, "${aws_dynamodb_table.app.arn}-bot-????????????????????????????????"]
      Condition = {
        "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["workspace", "roughmate", "knowledge", "wiki", "wiki-source#*", "wiki-manual#*", "wiki-manual-history#*", "wiki-version#*", "wiki-answer#*", "wiki-pending#*", "wiki-proposal#*", "wiki-maintenance#*", "wiki-command#*", "wiki-view#*", "wiki-erasure#*", "wiki-erasure-node#*", "request#*"] }
        Null                      = { "dynamodb:LeadingKeys" = "false" }
      }
    },
    {
      Sid      = "WikiBindingReads"
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem"]
      Resource = aws_dynamodb_table.app.arn
      Condition = {
        "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["registrations", "bot-archive#*"] }
        Null                      = { "dynamodb:LeadingKeys" = "false" }
      }
    },
    {
      Sid      = "WikiWrites"
      Effect   = "Allow"
      Action   = ["dynamodb:PutItem"]
      Resource = [aws_dynamodb_table.app.arn, "${aws_dynamodb_table.app.arn}-bot-????????????????????????????????"]
      Condition = {
        "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["wiki", "wiki-source#*", "wiki-manual#*", "wiki-version#*", "wiki-answer#*", "wiki-pending#*", "wiki-proposal#*", "wiki-maintenance#*", "wiki-command#*", "wiki-view#*", "wiki-erasure#*", "wiki-erasure-node#*"] }
        Null                      = { "dynamodb:LeadingKeys" = "false" }
      }
    },
    {
      Sid      = "WikiRetentionUpdates"
      Effect   = "Allow"
      Action   = ["dynamodb:UpdateItem"]
      Resource = [aws_dynamodb_table.app.arn, "${aws_dynamodb_table.app.arn}-bot-????????????????????????????????"]
      Condition = {
        "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["request#*"] }
        Null                      = { "dynamodb:LeadingKeys" = "false" }
      }
    },
    {
      Sid      = "WikiPublicationUpdates"
      Effect   = "Allow"
      Action   = ["dynamodb:UpdateItem"]
      Resource = [aws_dynamodb_table.app.arn, "${aws_dynamodb_table.app.arn}-bot-????????????????????????????????"]
      Condition = {
        "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["roughmate"] }
        Null                      = { "dynamodb:LeadingKeys" = "false" }
      }
    },
    {
      Sid      = "WikiPublicationChecks"
      Effect   = "Allow"
      Action   = ["dynamodb:ConditionCheckItem"]
      Resource = [aws_dynamodb_table.app.arn, "${aws_dynamodb_table.app.arn}-bot-????????????????????????????????"]
      Condition = {
        "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["roughmate", "knowledge", "wiki"] }
        Null                      = { "dynamodb:LeadingKeys" = "false" }
      }
    }
  ]
}
resource "aws_dynamodb_table" "app" {
  name         = local.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  attribute {
    name = "pk"
    type = "S"
  }
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
  server_side_encryption {
    enabled = true
  }
}
resource "aws_secretsmanager_secret" "runtime" {
  name                    = "${local.name}/runtime"
  recovery_window_in_days = 0
}
resource "aws_sqs_queue" "dead" {
  name                      = "${local.name}-dead"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}
resource "aws_sqs_queue" "jobs" {
  name                       = "${local.name}-jobs"
  visibility_timeout_seconds = 720
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead.arn
    maxReceiveCount     = 5
  })
}
resource "aws_iam_role" "lambda" {
  for_each             = toset(["http", "worker", "wiki-runner"])
  name                 = "${local.name}-${var.region}-${each.key}"
  permissions_boundary = "arn:aws:iam::${var.account_id}:policy/${local.name}-${var.region}-${each.key}-boundary"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}
resource "aws_cloudwatch_log_group" "lambda" {
  for_each          = toset(["http", "worker", "wiki-runner"])
  name              = "/aws/lambda/${local.name}-${each.key}"
  retention_in_days = 14
}
resource "aws_iam_role_policy" "lambda" {
  for_each = toset(["http", "worker", "wiki-runner"])
  role     = aws_iam_role.lambda[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [for statement in local.wiki_dynamodb_statements : statement if each.key == "wiki-runner"],
      [for statement in [{
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem", "dynamodb:DeleteItem"]
        Resource = [aws_dynamodb_table.app.arn, "${aws_dynamodb_table.app.arn}-bot-????????????????????????????????"]
      }] : statement if each.key != "wiki-runner"],
      [
        {
          Effect   = "Allow"
          Action   = each.key == "http" ? ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"] : ["secretsmanager:GetSecretValue"]
          Resource = [aws_secretsmanager_secret.runtime.arn, "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:${local.name}/bots/*/runtime-??????"]
        },
        {
          Effect   = "Allow"
          Action   = each.key == "http" ? ["sqs:SendMessage"] : ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
          Resource = each.key == "http" ? [aws_sqs_queue.jobs.arn, aws_sqs_queue.provision.arn] : each.key == "worker" ? [aws_sqs_queue.jobs.arn] : [aws_sqs_queue.wiki.arn]
        },
        {
          Effect   = "Allow"
          Action   = ["sqs:SendMessage"]
          Resource = aws_sqs_queue.wiki.arn
        },
        {
          Effect   = "Allow"
          Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
          Resource = "${aws_cloudwatch_log_group.lambda[each.key].arn}:*"
        }
      ]
    )
  })
}
resource "aws_lambda_function" "app" {
  for_each         = toset(["http", "worker", "wiki-runner"])
  function_name    = "${local.name}-${each.key}"
  role             = aws_iam_role.lambda[each.key].arn
  filename         = var.artifact
  source_code_hash = filebase64sha256(var.artifact)
  handler          = "${each.key}.handler"
  runtime          = "nodejs22.x"
  memory_size      = 512
  timeout          = each.key == "http" ? 10 : 120
  environment {
    variables = {
      TABLE_NAME          = aws_dynamodb_table.app.name
      SECRET_ARN          = aws_secretsmanager_secret.runtime.arn
      QUEUE_URL           = aws_sqs_queue.jobs.url
      WIKI_QUEUE_URL      = aws_sqs_queue.wiki.url
      PUBLIC_URL          = aws_apigatewayv2_api.http.api_endpoint
      PROVISION_QUEUE_URL = aws_sqs_queue.provision.url
    }
  }
  depends_on = [aws_iam_role_policy.lambda]
}
resource "aws_lambda_event_source_mapping" "jobs" {
  event_source_arn        = aws_sqs_queue.jobs.arn
  function_name           = aws_lambda_function.app["worker"].arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  scaling_config {
    maximum_concurrency = 2
  }
}
resource "aws_apigatewayv2_api" "http" {
  name          = local.name
  protocol_type = "HTTP"
}
resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.app["http"].invoke_arn
  payload_format_version = "2.0"
}
resource "aws_apigatewayv2_route" "routes" {
  for_each  = toset(["POST /slack/events", "POST /slack/interactive", "GET /oauth/callback", "POST /bots/{botId}/slack/events", "POST /bots/{botId}/slack/interactive", "GET /bots/{botId}/oauth/callback", "GET /channel-authorization/callback", "GET /bots/{botId}/channel-authorization/callback", "GET /wiki/{proxy+}", "POST /wiki/{proxy+}"])
  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }
}
resource "aws_lambda_permission" "gateway" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.app["http"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
