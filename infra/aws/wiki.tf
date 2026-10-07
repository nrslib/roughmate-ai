resource "aws_sqs_queue" "wiki_dead" {
  name                      = "${local.name}-wiki-dead"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}
resource "aws_sqs_queue" "wiki" {
  name                       = "${local.name}-wiki"
  visibility_timeout_seconds = 720
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.wiki_dead.arn
    maxReceiveCount     = 5
  })
}
resource "aws_lambda_event_source_mapping" "wiki" {
  provider                = aws.registration_mapping
  event_source_arn        = aws_sqs_queue.wiki.arn
  function_name           = aws_lambda_function.app["wiki-runner"].arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  scaling_config {
    maximum_concurrency = 2
  }
}
output "wiki_operations" {
  value = {
    queue_url    = aws_sqs_queue.wiki.url
    dead_url     = aws_sqs_queue.wiki_dead.url
    function_arn = aws_lambda_function.app["wiki-runner"].arn
    mapping_id   = aws_lambda_event_source_mapping.wiki.uuid
  }
}
