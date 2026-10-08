locals {
  name        = "roughmate-${var.environment}"
  http_name   = "${local.name}-http"
  worker_name = "${local.name}-worker"
  public_url  = "https://${local.http_name}-${var.project_number}.${var.region}.run.app"
  worker_url  = "https://${local.worker_name}-${var.project_number}.${var.region}.run.app"
  labels      = { application = "roughmate-self-hosted", environment = var.environment }
  queues      = toset(["jobs", "wiki", "provision"])
  runtime_env = {
    ROUGH_MATE_CLOUD_RUN        = "1"
    GOOGLE_CLOUD_PROJECT        = var.project
    GOOGLE_CLOUD_PROJECT_NUMBER = var.project_number
    GOOGLE_CLOUD_LOCATION       = var.region
    FIRESTORE_DATABASE          = google_firestore_database.runtime.name
    TABLE_NAME                  = local.name
    SECRET_ARN                  = "projects/${var.project_number}/secrets/${local.name}-runtime"
    CONFIGURATION_SECRET_ARN    = "projects/${var.project_number}/secrets/${local.name}-configuration"
    PUBLIC_URL                  = local.public_url
    WORKER_URL                  = local.worker_url
    TASK_SERVICE_ACCOUNT        = google_service_account.tasks.email
    QUEUE_URL                   = google_cloud_tasks_queue.runtime["jobs"].id
    WIKI_QUEUE_URL              = google_cloud_tasks_queue.runtime["wiki"].id
    PROVISION_QUEUE_URL         = google_cloud_tasks_queue.runtime["provision"].id
  }
}
resource "google_service_account" "runtime" { account_id = "${local.name}-runtime" }
resource "google_service_account" "tasks" { account_id = "${local.name}-tasks" }
resource "google_service_account" "scheduler" { account_id = "${local.name}-scheduler" }
resource "google_service_account" "build" { account_id = "${local.name}-build" }
resource "google_firestore_database" "runtime" {
  name                    = local.name
  location_id             = var.region
  type                    = "FIRESTORE_NATIVE"
  database_edition        = "STANDARD"
  concurrency_mode        = "PESSIMISTIC"
  deletion_policy         = "ABANDON"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
}
resource "google_firestore_field" "expiry" {
  project    = var.project
  database   = google_firestore_database.runtime.name
  collection = "records"
  field      = "expiresAt"
  index_config {}
  ttl_config {}
}
resource "google_firestore_field" "payload" {
  project    = var.project
  database   = google_firestore_database.runtime.name
  collection = "records"
  field      = "payload"
  index_config {}
}
resource "google_project_iam_member" "database" {
  project = var.project
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"
  condition {
    title      = "${local.name}-database"
    expression = "resource.name == 'projects/${var.project}/databases/${google_firestore_database.runtime.name}'"
  }
}
resource "google_project_iam_custom_role" "secret_create" {
  role_id     = "roughmate_${replace(var.environment, "-", "_")}_secret_create"
  title       = "Roughmate child secret creation"
  permissions = ["secretmanager.secrets.create"]
}
resource "google_project_iam_member" "secret_create" {
  project = var.project
  role    = google_project_iam_custom_role.secret_create.name
  member  = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_project_iam_custom_role" "secret_runtime" {
  role_id     = "roughmate_${replace(var.environment, "-", "_")}_secret_runtime"
  title       = "Roughmate runtime secret access"
  permissions = ["secretmanager.secrets.get", "secretmanager.versions.add", "secretmanager.versions.access", "secretmanager.versions.list"]
}
resource "google_project_iam_member" "secret_runtime" {
  project = var.project
  role    = google_project_iam_custom_role.secret_runtime.name
  member  = "serviceAccount:${google_service_account.runtime.email}"
  condition {
    title      = "${local.name}-secrets"
    expression = "resource.name == 'projects/${var.project_number}/secrets/${local.name}-runtime' || resource.name.startsWith('projects/${var.project_number}/secrets/${local.name}-runtime/versions/') || resource.name == 'projects/${var.project_number}/secrets/${local.name}-configuration' || resource.name.startsWith('projects/${var.project_number}/secrets/${local.name}-configuration/versions/') || resource.name.startsWith('projects/${var.project_number}/secrets/${local.name}-bot-')"
  }
}
resource "google_secret_manager_secret" "root" {
  for_each  = toset(["runtime", "configuration"])
  secret_id = "${local.name}-${each.key}"
  labels    = local.labels
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
}
resource "google_cloud_tasks_queue" "runtime" {
  for_each = local.queues
  name     = "${local.name}-${each.key}"
  location = var.region
  rate_limits {
    max_dispatches_per_second = 2
    max_concurrent_dispatches = 2
  }
  retry_config {
    max_attempts       = 8
    max_retry_duration = "86400s"
    min_backoff        = "10s"
    max_backoff        = "600s"
    max_doublings      = 5
  }
}
resource "google_cloud_tasks_queue_iam_member" "enqueue" {
  for_each = local.queues
  project  = var.project
  location = var.region
  name     = google_cloud_tasks_queue.runtime[each.key].name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_service_account_iam_member" "task_act_as" {
  service_account_id = google_service_account.tasks.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_service_account_iam_member" "task_tokens" {
  service_account_id = google_service_account.tasks.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${var.project_number}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
}
resource "google_artifact_registry_repository" "runtime" {
  location      = var.region
  repository_id = local.name
  format        = "DOCKER"
  labels        = local.labels
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions { keep_count = 3 }
  }
}
resource "google_artifact_registry_repository_iam_member" "build" {
  location   = var.region
  repository = google_artifact_registry_repository.runtime.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.build.email}"
}
resource "google_project_iam_member" "build_logs" {
  project = var.project
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.build.email}"
}
resource "google_cloud_run_v2_service" "runtime" {
  for_each            = var.services_enabled ? toset(["http", "worker"]) : toset([])
  name                = each.key == "http" ? local.http_name : local.worker_name
  location            = var.region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_ALL"
  labels              = local.labels
  template {
    service_account                  = google_service_account.runtime.email
    timeout                          = each.key == "http" ? "30s" : "180s"
    max_instance_request_concurrency = each.key == "http" ? 20 : 1
    scaling {
      min_instance_count = 0
      max_instance_count = each.key == "http" ? 2 : 3
    }
    containers {
      image = var.image
      ports { container_port = 8080 }
      resources {
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = true
        startup_cpu_boost = false
      }
      dynamic "env" {
        for_each = merge(local.runtime_env, { SERVICE_ROLE = each.key })
        content {
          name  = env.key
          value = env.value
        }
      }
      startup_probe {
        http_get {
          path = "/health"
        }
        period_seconds    = 5
        failure_threshold = 24
      }
    }
  }
  lifecycle {
    precondition {
      condition     = !var.services_enabled || var.image != "" && length("${local.worker_name}-${var.project_number}") <= 63
      error_message = "Image is required and deterministic Cloud Run DNS segment must fit 63 characters."
    }
  }
  depends_on = [google_project_iam_member.database, google_project_iam_member.secret_runtime, google_cloud_tasks_queue_iam_member.enqueue, google_service_account_iam_member.task_act_as]
}
resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.services_enabled ? 1 : 0
  name     = google_cloud_run_v2_service.runtime["http"].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
resource "google_cloud_run_v2_service_iam_member" "worker" {
  for_each = var.services_enabled ? toset(["tasks", "scheduler"]) : toset([])
  name     = google_cloud_run_v2_service.runtime["worker"].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${each.key == "tasks" ? google_service_account.tasks.email : google_service_account.scheduler.email}"
}
resource "google_cloud_scheduler_job" "rotation" {
  count            = var.services_enabled ? 1 : 0
  name             = "${local.name}-rotation"
  region           = var.region
  schedule         = "*/30 * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "180s"
  retry_config {
    retry_count          = 3
    min_backoff_duration = "30s"
    max_backoff_duration = "300s"
  }
  http_target {
    uri         = "${local.worker_url}/rotate"
    http_method = "POST"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode(jsonencode({ kind = "rotate" }))
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = local.worker_url
    }
  }
  depends_on = [google_cloud_run_v2_service_iam_member.worker]
}
resource "google_storage_bucket" "build_sources" {
  name                        = "${var.project_number}-${local.name}-build"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true
  labels                      = local.labels
  lifecycle_rule {
    condition { age = 1 }
    action { type = "Delete" }
  }
}
resource "google_storage_bucket_iam_member" "build_sources" {
  bucket = google_storage_bucket.build_sources.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.build.email}"
}
resource "google_logging_project_exclusion" "oauth_requests" {
  name        = "${local.name}-private-http-urls"
  description = "Do not retain authorization callback codes/state or Wiki URLs in default request log storage."
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.http_name}\" AND logName=\"projects/${var.project}/logs/run.googleapis.com%2Frequests\" AND (httpRequest.requestUrl =~ \"/(oauth/callback|channel-authorization/callback|wiki/)\")"
}
