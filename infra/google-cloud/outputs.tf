output "public_url" { value = local.public_url }
output "worker_url" { value = local.worker_url }
output "database" { value = google_firestore_database.runtime.name }
output "runtime_account" { value = google_service_account.runtime.email }
output "build_account" { value = google_service_account.build.email }
output "image_repository" { value = "${var.region}-docker.pkg.dev/${var.project}/${local.name}/runtime" }
output "retained_database" { value = "projects/${var.project}/databases/${google_firestore_database.runtime.name}" }
output "build_source_bucket" { value = google_storage_bucket.build_sources.name }
