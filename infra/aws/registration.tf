resource "aws_secretsmanager_secret" "configuration" {
  name                    = "${local.name}/configuration"
  recovery_window_in_days = 0
}
resource "aws_sqs_queue" "provision_dead" {
  name                      = "${local.name}-provision-dead"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}
resource "aws_sqs_queue" "provision" {
  name                       = "${local.name}-provision"
  visibility_timeout_seconds = 720
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.provision_dead.arn
    maxReceiveCount     = 5
  })
}
resource "aws_cloudwatch_log_group" "provisioner" {
  name              = "/aws/lambda/${local.name}-provisioner"
  retention_in_days = 14
}
resource "aws_iam_role" "provisioner" {
  name                 = "${local.name}-${var.region}-provisioner"
  permissions_boundary = "arn:aws:iam::${var.account_id}:policy/${local.name}-${var.region}-provisioner-boundary"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}
resource "aws_iam_role_policy" "provisioner" {
  role = aws_iam_role.provisioner.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = aws_dynamodb_table.app.arn
        Condition = {
          "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["workspace", "registrations", "registration#configuration", "bot-archive#*"] }
          Null                      = { "dynamodb:LeadingKeys" = "false" }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem"]
        Resource = aws_dynamodb_table.app.arn
        Condition = {
          "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["registrations", "registration#configuration", "bot-archive#*"] }
          Null                      = { "dynamodb:LeadingKeys" = "false" }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:ConditionCheckItem"]
        Resource = aws_dynamodb_table.app.arn
        Condition = {
          "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["workspace"] }
          Null                        = { "dynamodb:LeadingKeys" = "false" }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:DescribeTable", "dynamodb:ListTagsOfResource", "dynamodb:DescribeTimeToLive", "dynamodb:UpdateTimeToLive"]
        Resource = "${aws_dynamodb_table.app.arn}-bot-????????????????????????????????"
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:CreateTable", "dynamodb:TagResource"]
        Resource = "${aws_dynamodb_table.app.arn}-bot-????????????????????????????????"
        Condition = {
          StringEquals                = { "aws:RequestTag/RoughmateParent" = local.name }
          "ForAllValues:StringEquals" = { "aws:TagKeys" = ["RoughmateParent", "RegistrationId"] }
          Null                        = { "aws:TagKeys" = "false", "aws:RequestTag/RegistrationId" = "false" }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = "${aws_dynamodb_table.app.arn}-bot-????????????????????????????????"
        Condition = {
          "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["roughmate", "knowledge", "wiki"] }
          Null                        = { "dynamodb:LeadingKeys" = "false" }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem"]
        Resource = "${aws_dynamodb_table.app.arn}-bot-????????????????????????????????"
        Condition = {
          "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["roughmate#setup", "roughmate", "knowledge"] }
          Null                        = { "dynamodb:LeadingKeys" = "false" }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:UpdateItem"]
        Resource = "${aws_dynamodb_table.app.arn}-bot-????????????????????????????????"
        Condition = {
          "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["workspace", "roughmate"] }
          Null                        = { "dynamodb:LeadingKeys" = "false" }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.runtime.arn
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
        Resource = aws_secretsmanager_secret.configuration.arn
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:CreateSecret", "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:TagResource"]
        Resource = "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:${local.name}/bots/*/runtime-??????"
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:SendMessage"]
        Resource = aws_sqs_queue.provision.arn
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = [aws_sqs_queue.jobs.arn, aws_sqs_queue.wiki.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.provisioner.arn}:*"
      }
    ]
  })
}
resource "aws_lambda_function" "provisioner" {
  function_name    = "${local.name}-provisioner"
  role             = aws_iam_role.provisioner.arn
  filename         = var.artifact
  source_code_hash = filebase64sha256(var.artifact)
  handler          = "provisioner.handler"
  runtime          = "nodejs22.x"
  memory_size      = 512
  timeout          = 120
  environment {
    variables = {
      TABLE_NAME               = aws_dynamodb_table.app.name
      SECRET_ARN               = aws_secretsmanager_secret.runtime.arn
      CONFIGURATION_SECRET_ARN = aws_secretsmanager_secret.configuration.arn
      WIKI_QUEUE_URL           = aws_sqs_queue.wiki.url
      QUEUE_URL                = aws_sqs_queue.jobs.url
      PROVISION_QUEUE_URL      = aws_sqs_queue.provision.url
      PUBLIC_URL               = aws_apigatewayv2_api.http.api_endpoint
    }
  }
  depends_on = [aws_iam_role_policy.provisioner]
}
resource "aws_lambda_event_source_mapping" "provision" {
  provider                = aws.registration_mapping
  event_source_arn        = aws_sqs_queue.provision.arn
  function_name           = aws_lambda_function.provisioner.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  scaling_config { maximum_concurrency = 2 }
}
provider "aws" {
  alias               = "registration_mapping"
  region              = var.region
  allowed_account_ids = [var.account_id]
}
resource "aws_scheduler_schedule_group" "configuration" {
  name = "${local.name}-configuration"
}
resource "aws_iam_role" "scheduler" {
  name                 = "${local.name}-${var.region}-scheduler"
  permissions_boundary = "arn:aws:iam::${var.account_id}:policy/${local.name}-${var.region}-scheduler-boundary"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = var.account_id }, ArnEquals = { "aws:SourceArn" = aws_scheduler_schedule_group.configuration.arn } }
    }]
  })
}
resource "aws_iam_role_policy" "scheduler" {
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["sqs:SendMessage"], Resource = [aws_sqs_queue.provision.arn, aws_sqs_queue.provision_dead.arn] }]
  })
}
resource "aws_scheduler_schedule" "configuration_refresh" {
  name                = "${local.name}-configuration-refresh"
  group_name          = aws_scheduler_schedule_group.configuration.name
  schedule_expression = "rate(30 minutes)"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_sqs_queue.provision.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ kind = "rotate" })
    retry_policy {
      maximum_event_age_in_seconds = 3600
      maximum_retry_attempts       = 3
    }
    dead_letter_config { arn = aws_sqs_queue.provision_dead.arn }
  }
  depends_on = [aws_iam_role_policy.scheduler]
}
